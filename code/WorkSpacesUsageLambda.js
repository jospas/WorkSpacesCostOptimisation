var AWS = require("aws-sdk");
const { gzip } = require("node-gzip");
var ws = require("./WorkSpacesUsageModule");
var moment = require("moment");

/**
 * Lambda execution point
 */
exports.handler = async (event, context, callback) => 
{
    console.log("[INFO] Processing event:\n%s", JSON.stringify(event, null, 2));

    try
    {
        // When we started in UTC
        var nowUTC = moment.utc();
        console.log("[INFO] Starting loading workspaces at: " + nowUTC.format());

        // Creates config from environment
        var config = createConfig();

        // Updates AWS config
        updateAWSConfig(config);

        // Create the clients
        var awsworkspaces = new AWS.WorkSpaces();
        var awscloudwatch = new AWS.CloudWatch();

        // Load the workspaces pricing for this region
        var regionPricing = await ws.getRegionPricing(config);

        // Load the customer bundles
        var customerBundles = await ws.describeWorkspaceBundles(config, null, awsworkspaces);
        console.log("[INFO] Loaded: %d customer bundles", customerBundles.length);

        // Load the amazon bundles
        var amazonBundles = await ws.describeWorkspaceBundles(config, "AMAZON", awsworkspaces);
        console.log("[INFO] Loaded: %d Amazon bundles", amazonBundles.length);

        // Join the bundles
        var allBundles = customerBundles.concat(amazonBundles);

        // Loads the workspaces and metrics from the AWS account
        var workspaces = await ws.getWorkSpaces(config, awsworkspaces);
        console.log("[INFO] Loaded: %d workspaces", workspaces.length);

        // Load usage from CloudWatch
        await ws.getWorkSpacesUsage(config, awscloudwatch, workspaces, allBundles, regionPricing);

        // Save compressed populated workspace json data
        const compressedWorkspaces = await gzip(JSON.stringify(workspaces, null, "  "));

        // Clear credentials
        AWS.config.credentials = null;

        // S3 connection
        var amazons3 = new AWS.S3();

        // Save workpsaces data to S3
        await saveToS3(amazons3, 
            config.bucket, 
            config.keyPrefix + "workspaces_" + nowUTC.format("YYYY_MM") + ".json.gz", 
            "application/x-gzip",
            compressedWorkspaces);

        callback(null, "Finished");
    }
    catch (error)
    {
        console.log("[ERROR] failed to execute", error);
        callback(error, "Failed to execute");
    }
};

/**
 * Writes an object to S3
 */
async function saveToS3(s3, bucket, key, contentType, data)
{
    try
    {
        console.log('[INFO] About to write object to: s3://%s%s', bucket, key);

        var putRequest = {
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: contentType
        };

        await s3.putObject(putRequest).promise();

        console.log('[INFO] Wrote object to: s3://%s%s', bucket, key);
    }
    catch (error)
    {
        console.log('[ERROR] Failed to write to S3: ' + error);
        throw error;
    }
}

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
        console.log("[INFO] Injected temporary AWS credentials");
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
    config.windowsBYOL = (process.env.WINDOWS_BYOL == 'true');
    config.bucket = process.env.BUCKET;
    config.keyPrefix = process.env.KEY_PREFIX;

    ws.processConfig(config);

    console.log("[INFO] Made configuration: %s", JSON.stringify(config, null, "  "));

    return config;
}

