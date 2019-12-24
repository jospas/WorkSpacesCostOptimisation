
var fs = require('fs');
var sprintf = require('sprintf-js').sprintf;
var AWS = require('aws-sdk');
var ws = require('./WorkSpacesUsageModule');

/**
 * Program entry point that looks up all workspaces and
 * their usage and works out if swapping billing mode 
 * will save costs.
 */
async function run () 
{
  try
  {
    // Make the output directory
    fs.mkdirSync("./output", { recursive: true });

    // Find out the config file to use
    var configFile = getConfigFile();

    // Load the config file
    var config = JSON.parse(fs.readFileSync(configFile)); 

    // Processes the config
    ws.processConfig(config);

    // If we are using a profile credentials provider, enable it
    if (config.profile)
    {
      var credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
      AWS.config.credentials = credentials;
    }
    // Set the region from config
    AWS.config.update({region: config.region});
    
    // Initialise AWS components post region and credentials setup
    var awsworkspaces = new AWS.WorkSpaces();
    var awscloudwatch = new AWS.CloudWatch();

    // Load the public pricing for the configured region
    var publicPricing = await ws.getPublicPricing(config);
    fs.writeFileSync("output/public_pricing.json", JSON.stringify(publicPricing, null, "  "));
    console.log("[INFO] Wrote pricing data to: output/public_pricing.json");

    // Load the customer bundles
    var customerBundles = await ws.describeWorkspaceBundles(config, null, awsworkspaces, publicPricing);
    fs.writeFileSync("output/customer_bundles.json", JSON.stringify(customerBundles, null, "  "));
    console.log("[INFO] Wrote customer bundles to: output/customer_bundles.json");

    // Load the amazon bundles
    var amazonBundles = await ws.describeWorkspaceBundles(config, "AMAZON", awsworkspaces, publicPricing);
    fs.writeFileSync("output/amazon_bundles.json", JSON.stringify(amazonBundles, null, "  "));
    console.log("[INFO] Wrote Amazon bundles to: output/amazon_bundles.json");

    // Join the bundles
    var allBundles = customerBundles.concat(amazonBundles);

    // Loads the workspaces and metrics from the AWS account
    var workspaces = await ws.getWorkSpaces(config, awsworkspaces);          

    // Load usage from CloudWatch and create the CSV data populating workspaces
    var csvData = await ws.getWorkSpacesUsage(config, awscloudwatch, workspaces, allBundles);
    fs.writeFileSync("output/usage.csv", csvData);
    console.log("[INFO] Wrote usage data to: output/usage.csv");

    // Save populated workspace json data
    fs.writeFileSync("output/workspaces.json", JSON.stringify(workspaces, null, "  "));
    console.log("[INFO] Wrote workspaces to: output/workspaces.json");         

    // Log total potential savings
    console.log(sprintf("[INFO] Total potential monthly savings: $%.2f", config.TotalSavings));
    console.log(sprintf("[INFO] Total potential yearly savings: $%.2f", config.TotalSavings * 12.0));     

    // Convert billing modes if requested and write out the script
    // for manual conversion
    var outputScript = await ws.convertBillingModes(config, awsworkspaces, workspaces);

    fs.writeFileSync("output/updateBilling.sh", outputScript);
    console.log("[INFO] Wrote update billing script to: output/updateBilling.sh"); 

    // Success
    process.exit(0);

  }
  catch (error)
  {
    console.log("\n[ERROR] " + error.message, error);
    process.exit(1);
  }
}

/**
 * Grab the config file from the command line
 */
function getConfigFile()
{
  var commandLine = process.argv.slice(2);

  if (commandLine.length != 1)
  {
    throw new Error("Usage: node WorkSpacesUage.js <config file>");
  }

  return commandLine[0];
}

/**
 * Register the command line entry point
 */
if (require.main == module)
{
  run();
}