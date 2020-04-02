
var fs = require("fs");
var sprintf = require("sprintf-js").sprintf;
var AWS = require("aws-sdk");
const { gzip } = require("node-gzip");
var ws = require("./WorkSpacesUsageModule");
var moment = require("moment");

/**
 * Program entry point that looks up all workspaces and
 * their usage and works out if swapping billing mode 
 * will save costs.
 */
async function run () 
{
  try
  {
    // When we started in PST (UTC - 7H)
    var nowPST = moment.utc().add(-7, 'hours');
    console.log("[INFO] Starting loading workspaces at: " + nowPST.format() + " in PST");

    // Make the output directory
    fs.mkdirSync("./output", { recursive: true });

    // Find out the config file to use
    var configFile = getConfigFile();

    // Load the config file
    var config = JSON.parse(fs.readFileSync(configFile)); 

    // Processes the config
    ws.processConfig(config);

    // Set the region from config
    AWS.config.update({region: config.region});    

    // Use default credentials for now
    var amazons3 = new AWS.S3();

    // If we are using a profile credentials provider, enable it
    if (config.profile)
    {
      var credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
      AWS.config.credentials = credentials;
    }
    
    // Initialise AWS components post region and credentials setup
    var awsworkspaces = new AWS.WorkSpaces();
    var awscloudwatch = new AWS.CloudWatch();

    // Load the public pricing for the configured region
    var publicPricing = await ws.getPublicPricing(config);

    // Load the customer bundles
    var customerBundles = await ws.describeWorkspaceBundles(config, null, awsworkspaces, publicPricing);
    console.log("[INFO] Loaded: %d customer bundles", customerBundles.length);

    // Load the amazon bundles
    var amazonBundles = await ws.describeWorkspaceBundles(config, "AMAZON", awsworkspaces, publicPricing);
    console.log("[INFO] Loaded: %d Amazon bundles", amazonBundles.length);

    // Join the bundles
    var allBundles = customerBundles.concat(amazonBundles);

    // Loads the workspaces and metrics from the AWS account
    var workspaces = await ws.getWorkSpaces(config, awsworkspaces);
    console.log("[INFO] Loaded: %d workspaces", workspaces.length);          

    // Load usage from CloudWatch
    await ws.getWorkSpacesUsage(config, awscloudwatch, workspaces, allBundles);

    // Save compressed populated workspace json data
    const compressedWorkspaces = await gzip(JSON.stringify(workspaces, null, "  "));
    fs.writeFileSync("output/workspaces.json.gz", compressedWorkspaces);
    fs.writeFileSync("output/workspaces_" + nowPST.format("YYYY_MM") + ".json.gz", compressedWorkspaces);        

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