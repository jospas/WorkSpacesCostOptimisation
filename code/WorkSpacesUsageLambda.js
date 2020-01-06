var fs = require("fs");
var sprintf = require("sprintf-js").sprintf;
var AWS = require("aws-sdk");
var ws = require("./WorkSpacesUsageModule");

/**
 * Lambda execution point
 */
exports.handler = async (event, context, callback) => 
{
    console.log("[INFO] Processing event:\n%s", JSON.stringify(event, null, 2));

    try
    {
        // Creates config from environment
        var config = createConfig();

        // Use local Lambda credentials for DynamoDB
        var awsdynamodb = new AWS.DynamoDB();
        var amazons3 = new AWS.S3();

        // Updates AWS config
        updateAWSConfig(config);

        // Create the clients
        var awsworkspaces = new AWS.WorkSpaces();
        var awscloudwatch = new AWS.CloudWatch();

        // Load the public pricing for the configured region
        var publicPricing = await ws.getPublicPricing(config);
        console.log("[INFO] loaded public pricing: %j", publicPricing);

        // Load the customer bundles
        var customerBundles = await ws.describeWorkspaceBundles(config, null, awsworkspaces, publicPricing);
        console.log("[INFO] Loaded %d customer bundles", customerBundles.length);

        // Load the amazon bundles
        var amazonBundles = await ws.describeWorkspaceBundles(config, "AMAZON", awsworkspaces, publicPricing);
        console.log("[INFO] Loaded %d Amazon bundles", amazonBundles.length);

        // Join the bundles
        var allBundles = customerBundles.concat(amazonBundles);

        // Loads the workspaces and metrics from the AWS account
        var workspaces = await ws.getWorkSpaces(config, awsworkspaces);
        console.log("[INFO] Loaded %d workspaces", workspaces.length);

        // Load usage from CloudWatch and create the CSV data populating workspaces
        var csvData = await ws.getWorkSpacesUsage(config, awscloudwatch, workspaces, allBundles);
        console.log("[INFO] made csv data:\n%s", csvData);

        // Save the usage data to DynamoDB
        await ws.saveToDynamoDB(config, awsdynamodb, workspaces);

        // Log total potential savings
        console.log(sprintf("[INFO] Total potential monthly savings: $%.2f", config.TotalSavings));
        console.log(sprintf("[INFO] Total potential yearly savings: $%.2f", config.TotalSavings * 12.0));     

        // Convert billing modes if requested and write out the script
        // for manual conversion
        var outputScript = await ws.convertBillingModes(config, awsworkspaces, workspaces);

        console.log("[INFO] Update script:\n%s", outputScript); 

        callback(null, "Finished");
    }
    catch (error)
    {
        console.log("[ERROR] failed to execute", error);
        callback(error, "Failed to execute");
    }
};

/**
 * Updates AWS config setting the region and optionally
 * injecting temp credentials
 */
function updateAWSConfig(config)
{
    // Set the region from config
    AWS.config.update({region: config.region});

    // Inject credentials for testing if configured
    // TODO remove this code before deployment
    if (process.env.TEMP_ACCESS_KEY && process.env.TEMP_SECRET_KEY)
    {
        AWS.config.update({accessKeyId: process.env.TEMP_ACCESS_KEY, 
            secretAccessKey: process.env.TEMP_SECRET_KEY});
        console.log("[INFO] injected temporary AWS credentials");
    }
}

/**
 * Creates configuration from environment variables
 */
function createConfig()
{
    var config = {};

    config.region = process.env.REGION;
    config.directoryId = process.env.DIRECTORY_ID;
    config.windowsBYOL = process.env.WINDOWS_BYOL;
    config.dynamoDBTable = process.env.STAGE + "-workspaces-usage";

    ws.processConfig(config);

    console.log("[INFO] made configuration: %j", config);

    return config;
}

