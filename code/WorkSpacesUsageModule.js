var fs = require("fs");
var sprintf = require("sprintf-js").sprintf;
var AWS = require("aws-sdk");
var axios = require("axios");
var parquet = require("parquetjs");
var moment = require("moment");

/**
 * Processes the config
 */
exports.processConfig = function(config)
{
  config.TotalSavings = 0.0;
  config.lastDayOfMonth = isLastDayOfMonth();
  console.log("[INFO] Last day of month: " + config.lastDayOfMonth);
}

/**
 * Converts billing mode for all workspaces if requested
 * and always responds with a conversion script
 */
exports.convertBillingModes = async function(config, awsworkspaces, workspaces)
{
  var outputScript = "#!/bin/bash\n\n";

  var convertedWorkspaces = 0;

  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      var workspace = workspaces[i];

      printProgress(config, sprintf("[INFO] Converting billing modes: %.0f%%", i * 100.0 / workspaces.length));

      if (workspace.Action === "CONVERT")
      {
        // Disabled conversion for now
        if (false)
        {
          await convertBillingMode(config, awsworkspaces, workspace);
          convertedWorkspaces++;  
        }

        outputScript += createUpdateScriptLine(config, workspace);
      }
    }
  }
  catch (error)
  {
    throw error;
  }

  printProgressDivider(config);

  return outputScript;
}

/**
 * Describes workspaces bundles and computes 
 * hourly and monthly pricing
 */
exports.describeWorkspaceBundles = async function(config, owner, awsworkspaces, publicPricing)
{

  console.log("[INFO] Loading workspaces bundles for owner: " + owner);

  var params = 
  {
    Owner: owner
  };

  var results = [];

  try
  {
    var response = await describeWorkspaceBundlesPage(params, awsworkspaces);
    results = results.concat(response.Bundles);
    printProgress(config, "[INFO] Bundles loaded: " + results.length);

    while (response.NextToken)
    {
      params.NextToken = response.NextToken;
      response = await describeWorkspaceBundlesPage(params, awsworkspaces);
      results = results.concat(response.Bundles);
      printProgress(config, "[INFO] Bundles loaded: " + results.length);
    }

    printProgressDivider(config);

    /**
     * Process each bundle computing the pricing
     */
    results.forEach(bundle =>
    {
      if (bundle.Name.includes("Windows"))
      {
        bundle.Windows = true;
      }
      else
      {
        bundle.Windows = false;
      }

      populateBundlePricing(config, publicPricing, bundle);
    });

    return results;
  }
  catch (error)
  {
    console.log("\n[ERROR] Failed to retrieve bundles", error);
    throw error;
  }
}

/**
 * Loads information about all workspaces
 */
exports.getWorkSpaces = async function(config, awsworkspaces)
{
  console.log("[INFO] Loading workspaces...");

  var params = 
  {
    DirectoryId: config.directoryId
  };

  var results = [];

  try
  {
    var response = await getWorkspacesPage(params, awsworkspaces);
    results = results.concat(response.Workspaces);
    printProgress(config, "[INFO] Workspaces loaded: " + results.length);

    while (response.NextToken)
    {
      params.NextToken = response.NextToken;
      response = await getWorkspacesPage(params, awsworkspaces);
      results = results.concat(response.Workspaces);
      printProgress(config, "[INFO] Workspaces loaded: " + results.length);
    }

    printProgressDivider(config);

    return results;
  }
  catch (error)
  {
    console.log("\n[ERROR] Failed to retrieve workspaces", error);
    throw error;
  }
}

/**
 * Loads usage for all WorkSpaces from CloudWatch
 */
exports.getWorkSpacesUsage = async function(config, awscloudwatch, workspaces, bundles)
{
  console.log("[INFO] Loading workspaces usage...");

  var usageData = "BundleId,Description,"+
    "HourlyBasePrice,HourlyPrice,MonthlyPrice,OptimalMonthlyHours," +
    "DirectoryId,WorkSpaceId,UserName,ComputerName," +
    "State,ComputeType,CurrentMode," +
    "ConnectedHours,UsageCost,Utilisation," +
    "MaxUsage,MedianUsage,MeanUsage," +
    "Action,Savings\n";

  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      var connectedHours = await getWorkSpaceUsage(config, awscloudwatch, workspaces[i]);
      workspaces[i].ConnectedHours = connectedHours;

      usageData += analyseResults(config, workspaces[i], bundles);
      printProgress(config, sprintf("[INFO] Loading connected user metrics: %.0f%%", 
        i * 100.0 / workspaces.length));
    }

    printProgressDivider(config);
  }
  catch (error)
  {
    throw error;
  }

  return usageData;
}

/**
 * Fetches the compute type from the pricing bundle
 * converting to upper case and removing dashes
 */
function getComputeType(bundleType)
{
  var bt = bundleType.toUpperCase();

  bt = bt.replace(/ /g, "");
  bt = bt.replace(/(.*)-[0-9]+/, "$1");

  return bt;
}

/**
 * Returns true if this is the last day of the month
 */
function isLastDayOfMonth()
{
  var daysInMonth = getDaysInMonth();
  var now = moment.utc();
  return (daysInMonth == now.date());
}

/**
 * Downloads public pricing for Workspaces via the Pricing API
 */
exports.getPublicPricing = async function getPublicPricing(config)
{
  console.log("[INFO] Loading public pricing for region: " + config.region);

  var allRegionsUrl = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonWorkSpaces/current/region_index.json";
  var allRegionsResponse = await axios.get(allRegionsUrl);
  var allRegionsData = allRegionsResponse.data;
  var singleRegionUri = allRegionsData.regions[config.region].currentVersionUrl;
  var singleRegionUrl = "https://pricing.us-east-1.amazonaws.com" + singleRegionUri;
  var singleRegionResponse = await axios.get(singleRegionUrl);
  var singleRegionData = singleRegionResponse.data;

  // Iterate the hardware products extracting a bunch of relevant data
  var skus = Object.entries(singleRegionData["products"])
      .filter(product => product[1].attributes.resourceType === "Hardware")
      .map(function (product) 
  {
    var response = {};
    response.sku = product[1].sku;
    response.runningMode = product[1].attributes.runningMode;
    response.computeType = getComputeType(product[1].attributes.bundle);
    response.windows = product[1].attributes.operatingSystem === "Windows";
    response.os = response.windows ? "WINDOWS" : "LINUX";

    response.license = product[1].attributes.license.toUpperCase();

    if (response.license.startsWith("BRING YOUR"))
    {
      response.license = "BYOL";
    }

    if (response.license === "NONE")
    {
      response.license = "INCLUDED";
    }

    response.vcpus = product[1].attributes.vcpu;
    response.memory = product[1].attributes.memory.replace(" GB", "");

    if (product[1].attributes.rootvolume && product[1].attributes.uservolume) 
    {
      response.rootvolume = product[1].attributes.rootvolume.replace(" GB", "");  
      response.uservolume = product[1].attributes.uservolume.replace(" GB", "");
    }
    else if (product[1].attributes.storage && 
      product[1].attributes.storage.match(/Root:([0-9]+) GB,User:([0-9]+) GB/))
    {
      response.rootvolume = product[1].attributes.storage.replace(/Root:([0-9]+) GB,User:([0-9]+) GB/, "$1");
      response.uservolume = product[1].attributes.storage.replace(/Root:([0-9]+) GB,User:([0-9]+) GB/, "$2");
    }

    // Extract pricing
    var term = singleRegionData.terms.OnDemand[response.sku][response.sku + ".JRTCKXETXF"];

    // Skip limited use and trial SKUs
    if (term && term.priceDimensions)
    {
      term = term.priceDimensions[response.sku + ".JRTCKXETXF.6YS6EN2CT7"];

      if (term.unit)
      {
        response.unit = term.unit.toUpperCase().replace("-", "");
        response.price = term.pricePerUnit.USD;
        return response;
      }
    }

    console.log("[DEBUG] Skipping SKU with no valid pricing: " + response.sku);
    return null;
  });

  var mapResult = {};
  mapResult.WINDOWS = {};
  mapResult.LINUX = {};

  // Process the skus into a tree we can query
  skus.forEach(sku => 
  {
    if (sku && sku.computeType != "STORAGE")
    {
      if (!mapResult[sku.os][sku.license])
      {
        mapResult[sku.os][sku.license] = {};
      }

      if (!mapResult[sku.os][sku.license][sku.computeType])
      {
        mapResult[sku.os][sku.license][sku.computeType] = {};
        mapResult[sku.os][sku.license][sku.computeType].vcpus = sku.vcpus;
        mapResult[sku.os][sku.license][sku.computeType].memory = sku.memory;
      }

      if (!mapResult[sku.os][sku.license][sku.computeType][sku.runningMode])
      {
        mapResult[sku.os][sku.license][sku.computeType][sku.runningMode] = {};
      }

      if (!mapResult[sku.os][sku.license][sku.computeType][sku.runningMode][sku.unit])
      {
        mapResult[sku.os][sku.license][sku.computeType][sku.runningMode][sku.unit] = {};
      }

      if (sku.unit === "HOUR")
      {
        mapResult[sku.os][sku.license][sku.computeType][sku.runningMode][sku.unit] = sku.price;
      }
      else
      {
        if (sku.rootvolume && sku.uservolume)
        {
          mapResult[sku.os][sku.license][sku.computeType][sku.runningMode][sku.unit]
            [sku.rootvolume + "_" + sku.uservolume] = sku.price;  
        }
        else
        {
          mapResult[sku.os][sku.license][sku.computeType][sku.runningMode][sku.unit]["0_0"] = sku.price;
        }
      }
      
    }
  });

  return mapResult;
}

/**
 * Populates bundle pricing using loaded public pricing
 */
function populateBundlePricing(config, publicPricing, bundle)
{
  var os = (bundle.Windows ? "WINDOWS" : "LINUX");

  var license = "INCLUDED";

  if (bundle.Windows && config.windowsBYOL)
  {
    license = "BYOL";
  }

  var computeType = bundle.ComputeType.Name;
  var storageKey = bundle.RootStorage.Capacity + "_" + bundle.UserStorage.Capacity;

  var pricingNode = publicPricing[os][license][computeType];

  if (!pricingNode ||
      !pricingNode.AlwaysOn ||
      !pricingNode.AlwaysOn.MONTH ||
      !pricingNode.AutoStop ||
      !pricingNode.AutoStop.MONTH ||
      !pricingNode.AutoStop.HOUR)
  {
    throw new Error(sprintf("[ERROR] Failed to locate complete pricing for: [%s/%s/%s]", os, license, computeType));
  }
  
  var monthlyPrice = pricingNode.AlwaysOn.MONTH[storageKey];

  if (!monthlyPrice)
  {
    throw new Error(sprintf("[ERROR] Failed to locate always on monthly pricing for: [%s/%s/%s/%s]", os, license, computeType, storageKey));
  }

  var hourlyPrice = pricingNode.AutoStop.HOUR;

  if (!hourlyPrice)
  {
    throw new Error(sprintf("[ERROR] Failed to locate auto stop hourly pricing for: [%s/%s/%s]", os, license, computeType));
  }

  var hourlyBasePrice = pricingNode.AutoStop.MONTH[storageKey];

  if (!hourlyBasePrice)
  {
    throw new Error(sprintf("[ERROR] Failed to auto stop hourly base pricing for: [%s/%s/%s/%s]", os, license, computeType, storageKey));
  }

  bundle.monthlyPrice = monthlyPrice * 1;
  bundle.hourlyBasePrice = hourlyBasePrice * 1;
  bundle.hourlyPrice = hourlyPrice * 1;

  var crossOverHours = 0;
  var baseCost = bundle.hourlyBasePrice;

  while (baseCost < bundle.monthlyPrice)
  {
    baseCost += bundle.hourlyPrice;
    crossOverHours++;
  }

  bundle.optimalMonthlyHours = crossOverHours;
}


/**
 * Creates a line in a script to update billing mode
 */
function createUpdateScriptLine(config, workspace)
{
  if (workspace.Action !== "CONVERT")
  {
    return "";
  }

  var profileOption = "";

  if (config.profile)
  {
    profileOption = "--profile " + config.profile;
  }

  var newBillingMode = "";

  if (workspace.Mode === "MONTHLY")
  {
    newBillingMode = "RunningMode=AUTO_STOP";
  }
  else if (workspace.Mode === "HOURLY")
  {
    newBillingMode = "RunningMode=ALWAYS_ON";
  }

  return sprintf('echo "[INFO] Convert instance: [%s] user: [%s] current mode: [%s]"\n' +
    'echo "[INFO] Connected hours: %d"\n' +
    'echo "[INFO] Potential savings: %.2f USD"\n' +
    'echo "[INFO] Last day of month: %s"\n' +
    "aws workspaces modify-workspace-properties %s " +
    "--workspace-id %s --region %s " +
    "--workspace-properties %s\n\n",
      workspace.WorkspaceId,
      workspace.UserName, 
      workspace.Mode,
      workspace.ConnectedHours,
      workspace.Savings,
      config.lastDayOfMonth,
      profileOption,
      workspace.WorkspaceId,
      config.region,
      newBillingMode);
}

/**
 * Converts billing mode for a single workspace if configured
 */
async function convertBillingMode(config, awsworkspaces, workspace)
{
  var maxRetries = 10;
  var retry = 0;
  var lastError = null;

  while (retry < maxRetries)
  {
    try
    {
      var params = 
      {
        WorkspaceId: workspace.WorkspaceId,
        WorkspaceProperties: { }
      };

      if (workspace.Mode === "MONTHLY")
      {
        params.WorkspaceProperties.RunningMode = "AUTO_STOP";
      }
      else if (workspace.Mode === "HOURLY")
      {
        params.WorkspaceProperties.RunningMode = "ALWAYS_ON";
      }
      else
      {
        throw new Error("Unhandled workspaces billing mode: " + workspace.Mode);
      }

      await awsworkspaces.modifyWorkspaceProperties(params).promise();
      return;
    }
    catch (error)
    {
      lastError = error;
      await sleep(getSleepTime(retry));     
      retry++;
    }
  }
  throw new Error("Failed to convert a workspace, maximum retry count exceeded: " + lastError.message);
}

/**
 * Locate a configured bundle by bundleId
 */
function getBundle(workspace, bundles)
{
  var found = bundles.find(function(bundle) 
  {
    return bundle.BundleId === workspace.BundleId;
  });

  if (found)
  {
    return found;
  }
  else
  {
    throw new Error("Failed to locate bundle for workspace: " + JSON.stringify(workspace, null, "  "));
  }
}

/**
 * Fetches the number of days left in a month for a given date
 */
function getDaysLeftInMonth()
{
  var daysInMonth = getDaysInMonth();
  return daysInMonth - moment.utc().date();
}

/**
 * Fetches the number of days in a month
 */
function getDaysInMonth()
{
  return moment().utc().daysInMonth();
}

/**
 * Analyses the results for a workspace for this year
 */
function analyseResults(config, workspace, bundles)
{
  var runningMode = workspace.WorkspaceProperties.RunningMode;
  var bundle = getBundle(workspace, bundles);

  workspace.Mode = "";
  workspace.Action = "KEEP";
  workspace.Savings = 0.0;

  workspace.BundleDescription = bundle.Description;

  // The number of hours in this month that could have been billed
  var now = moment.utc();
  var start = getStartDate();
  var duration = moment.duration(now.diff(start));
  workspace.BillableHours = +duration.asHours().toFixed(2);

  workspace.Utilisation = 0.00;

  if (workspace.BillableHours > 0)
  {
    workspace.Utilisation = +(workspace.ConnectedHours / workspace.BillableHours).toFixed(2);
  }

  workspace.HourlyBasePrice = bundle.hourlyBasePrice;
  workspace.HourlyPrice = bundle.hourlyPrice;
  workspace.MonthlyPrice = bundle.monthlyPrice;
  workspace.OptimalMonthlyHours = bundle.optimalMonthlyHours;

  var hourlyCost = bundle.hourlyBasePrice + workspace.ConnectedHours * bundle.hourlyPrice;

  /**
   * Convert hourly billing to monthly if the current use plus the
   * monthly pro-rata amount exceeds the monthly cost
   */
  if (runningMode === "AUTO_STOP")
  {
    workspace.UsageCost = hourlyCost;
    workspace.Mode = "HOURLY";

    if (workspace.ConnectedHours >= bundle.optimalMonthlyHours)
    {
      workspace.Action = "CONVERT";
      workspace.Savings = hourlyCost - bundle.monthlyPrice;
    }
  }
  /**
   * Convert monthly billing back to hourly only at the end
   * of the month and only if the utilisation is low
   */
  else if (runningMode === "ALWAYS_ON")
  {
    workspace.UsageCost = bundle.monthlyPrice;
    workspace.Mode = "MONTHLY";
    if (config.lastDayOfMonth && (workspace.ConnectedHours < bundle.optimalMonthlyHours))
    {
      workspace.Action = "CONVERT";
      workspace.Savings = bundle.monthlyPrice - hourlyCost;
    }
  }

  var line = sprintf("%s,%s,%.2f,%.2f,%.2f,%d," +
      "%s,%s,%s,%s,%s,%s,%s," +
      "%d,%.2f,%.2f," +
      "%d,%d,%.1f," +
      "%s,%.2f\n",

    bundle.BundleId, 
    bundle.Description, 
    bundle.hourlyBasePrice,
    bundle.hourlyPrice,
    bundle.monthlyPrice,
    bundle.optimalMonthlyHours,

    workspace.DirectoryId,
    workspace.WorkspaceId,
    workspace.UserName,
    workspace.ComputerName,
    workspace.State,
    workspace.WorkspaceProperties.ComputeTypeName,
    workspace.Mode,

    workspace.ConnectedHours,
    workspace.UsageCost,
    workspace.Utilisation,

    workspace.MaxUsage,
    workspace.MedianUsage,
    workspace.MeanUsage,

    workspace.Action,
    workspace.Savings
  );

  config.TotalSavings += workspace.Savings;

  return line;
}

/**
 * Fetches a page of bundles sleeping and backing 
 * off if we get throttled
 */
async function describeWorkspaceBundlesPage(params, awsworkspaces)
{
  var maxRetries = 10;
  var retry = 0;

  var lastError = null;

  while (retry < maxRetries)
  {
    try
    {
      var response = await awsworkspaces.describeWorkspaceBundles(params).promise();
      return response;
    }
    catch (error)
    {
      lastError = error;
      await sleep(getSleepTime(retry));     
      retry++;
    }
  }
  throw new Error("Failed to describe bundles, maximum retry count exceeded: " + lastError.message);
}


/**
 * Fetches a page of workpsaces sleeping and backing 
 * off if we get throttled
 */
async function getWorkspacesPage(params, awsworkspaces)
{
  var maxRetries = 10;
  var retry = 0;

  var lastError = null;

  while (retry < maxRetries)
  {
    try
    {
      var response = await awsworkspaces.describeWorkspaces(params).promise();
      return response;
    }
    catch (error)
    {
      lastError = error;
      await sleep(getSleepTime(retry));     
      retry++;
    }
  }
  throw new Error("Failed to list workspaces, maximum retry count exceeded: " + lastError.message);
}

/**
 * Fetches the start of the workspaces billing month
 * which should be midnight on the 1st of the month in
 * Pacific Time (UTC -07:00)
 */
function getStartDate()
{
  return moment.utc().startOf('month').add(7, 'hours');
}

/**
 * Mean of non-zero daily usage
 */
function mean(dailyUsageArray)
{
  var total = 0;
  var count = 0;

  for (var i = 0; i < dailyUsageArray.length; i += 1) 
  {
    if (dailyUsageArray[i] > 0)
    {
      total += dailyUsageArray[i];
      count++;
    }
    
  }

  if (count > 0)
  {
    return total / count;  
  }
  else
  {
    return 0;
  }
  
}

/**
 * Median usage of non-zero days
 */
function median(dailyUsageArray)
{
  var nonZero = [];
  for (var i = 0; i < dailyUsageArray.length; i++)
  {
    if (dailyUsageArray[i] > 0)
    {
      nonZero.push(dailyUsageArray[i]);
    }
  }

  if (nonZero.length === 0)
  {
    return 0;
  }

  nonZero.sort();
 
  if (nonZero.length % 2 === 0)
  {
    return (nonZero[nonZero.length / 2 - 1] + nonZero[nonZero.length / 2]) / 2;
  }
  else 
  {
    return nonZero[(nonZero.length - 1) / 2];
  }
}

/**
 * Loads CloudWatch metrics for a workspace
 * and backing off and retrying if required.
 * Looks for hours with connected users for 
 * a baseline usage metric
 */
async function getWorkSpaceUsage(config, awscloudwatch, workspace)
{
  var maxRetries = 10;
  var retry = 0;
  var lastError = null;

  var startDate = getStartDate();
  var endDate = moment.utc()

  var params = {
    Dimensions: [],
    Namespace: "AWS/WorkSpaces",
    StartTime: startDate.toDate(),
    EndTime: endDate.toDate(),
    Period: 3600
  };

  params.Dimensions = params.Dimensions.concat({
    Name: "WorkspaceId",
    Value: workspace.WorkspaceId,
  });

  params.MetricName = "UserConnected";
  params.Statistics = ["Maximum"];

  while (retry < maxRetries)
  {
    try
    {
      var metrics = await awscloudwatch.getMetricStatistics(params).promise();

      var billableTime = 0;

      workspace.DailyUsage = [];
      workspace.DailyUsage.length = getDaysInMonth();
      workspace.DailyUsage.fill(0);

      for (var m = 0; m < metrics.Datapoints.length; m++)
      {
        if (metrics.Datapoints[m].Maximum > 0)
        {
          // Track daily aggregate usage (in UTC)
          var when = moment.utc(metrics.Datapoints[m].Timestamp);
          workspace.DailyUsage[when.date() - 1]++;

          // Track a billable hour
          billableTime++;
        }
      }

      workspace.MaxUsage = Math.max(...workspace.DailyUsage);
      workspace.MedianUsage = median(workspace.DailyUsage);
      workspace.MeanUsage = mean(workspace.DailyUsage);

      return billableTime;
    }
    catch (error)
    {
      lastError = error;
      await sleep(getSleepTime(retry));     
      retry++;
    }
  }

  throw new Error("Failed to load workspace utilisation, maximum retry count exceeded: " + lastError.message);
}

/**
 * Sleeps for the requested millis
 */
function sleep(millis)
{
  return new Promise(resolve => {
      setTimeout(resolve, millis);
  });
}

/**
 * Sleeps for the requested millis
 */
exports.sleepExport = function sleepExport(millis)
{
  return new Promise(resolve => {
      setTimeout(resolve, millis);
  });
}

/**
 * Fetches an exponential backoff maxing at 2500
 */
function getSleepTime(retry)
{
  if (retry <= 4)
  {
    return 2 ^ retry * 100;  
  }
  else
  {
    return 2500;
  }
}

/**
 * Print progress to console if we are in interactive mode
 */
function printProgress(config, message) 
{
  if (process.stdout.isTTY)
  {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(message);
  }
}

/**
 * In interactive mode print a new line
 */
function printProgressDivider(config) 
{
  if (process.stdout.isTTY)
  {
    console.log("");
  }
}

/**
 * Saves records to DynamoDB
 */
exports.saveToDynamoDB = async function saveToDynamoDB(config, dynamoDB, workspaces)
{
  try
  {
    var now = moment.utc();
    var period = now.format("YYYY-MM");

    console.log("[INFO] Writing usage data to DynamoDB table: " + config.dynamoDBTable);

    for (var i = 0; i < workspaces.length; i++)
    {
      var workspace = workspaces[i];

      var params = {
        TableName: config.dynamoDBTable,
        Item: 
        {
            "workspaceId" : {"S": workspace.WorkspaceId},
            "userId" : {"S": workspace.UserName},
            "period" : {"S": period},
            "usageData" : {"S": JSON.stringify(workspace)},
            "meanUsage" : {"N": "" + workspace.MeanUsage},
            "medianUsage" : {"N": "" + workspace.MedianUsage},
            "maxUsage" : {"N": "" + workspace.MaxUsage},
            "runningMode" : {"S": workspace.Mode},
            "billableHours" : {"N": "" + workspace.BillableHours},
            "connectedHours" : {"N": "" + workspace.ConnectedHours},            
            "utilisation": {"N": "" + workspace.Utilisation},
            "computeType": {"S": workspace.WorkspaceProperties.ComputeTypeName},
            "usageCost": {"S": "" + workspace.UsageCost},
            "savings": {"S": "" + workspace.Savings},
            "action": {"S": "" + workspace.Action},
            "hourlyBasePrice": {"N": "" + workspace.HourlyBasePrice},
            "hourlyPrice": {"N": "" + workspace.HourlyPrice},
            "monthlyPrice": {"N": "" + workspace.MonthlyPrice},
            "optimalMonthlyHours": {"N": "" + workspace.OptimalMonthlyHours},
            "processedDate":  {"S": now.toISOString() }
        }
      };

      var putResponse = await dynamoDB.putItem(params).promise();
    }

    console.log("[INFO] Writing usage data to DynamoDB is complete");
  }
  catch (error)
  {
    console.log("[ERROR] Failed to write to DynamoDB", error);
    throw error;
  }
}

/**
 * Creates a Parquet file and writes this to S3
 */
exports.writeParquetFile = async function writeParquetFile(config, s3, workspaces)
{
  if (!config.s3Bucket || !config.s3Prefix)
  {
    console.log("[INFO] writing to S3 is disabled");
    return;
  }

  try
  {
    var opts = { compression: "SNAPPY" };

    var schema = new parquet.ParquetSchema(
    {
      workspaceId : {type: "UTF8", compression: opts.compression},
      userId : {type: "UTF8", compression: opts.compression},
      bundleId: {type: "UTF8", compression: opts.compression},
      bundleDescription: {type: "UTF8", compression: opts.compression},
      hourlyBasePrice: {type: "FLOAT", compression: opts.compression},
      hourlyPrice: {type: "FLOAT", compression: opts.compression},
      monthlyPrice: {type: "FLOAT", compression: opts.compression},
      optimalMonthlyHours: {type: "FLOAT", compression: opts.compression},
      runningMode: {type: "UTF8", compression: opts.compression},
      processedDate: {type: "UTF8", compression: opts.compression},
      action: {type: "UTF8", compression: opts.compression},
      computeType: {type: "UTF8", compression: opts.compression},
      billableHours: {type: "INT32", compression: opts.compression},
      connectedHours: {type: "INT32", compression: opts.compression},
      utilisation: {type: "FLOAT", compression: opts.compression},
      meanUsage: {type: "FLOAT", compression: opts.compression},
      medianUsage: {type: "FLOAT", compression: opts.compression},
      maxUsage: {type: "FLOAT", compression: opts.compression},
      usageCost: {type: "FLOAT", compression: opts.compression},
      savings: {type: "FLOAT", compression: opts.compression}
    });

    var now = moment.utc();
    var nowString = now.toISOString();
    var fileName = sprintf("workspace-usage-%d-%02d.snappy.parquet", 
      now.year(), now.month());
    var localFile = "output/usage.parquet";
    fs.mkdirSync("./output", { recursive: true });
    var s3Path = sprintf("%sdirectory=%s/when=%d-%02d/%s", 
      config.s3Prefix, config.directoryId, now.year(), now.month(), fileName);

    var parquetWriter = await parquet.ParquetWriter.openFile(schema, localFile, opts);

    for (var i = 0; i < workspaces.length; i++)
    {
      var workspace = workspaces[i];

      await parquetWriter.appendRow(
      {
        workspaceId : workspace.WorkspaceId,
        userId : workspace.UserName,
        bundleId: workspace.BundleId,
        bundleDescription: workspace.BundleDescription,
        hourlyBasePrice: workspace.HourlyBasePrice,
        hourlyPrice: workspace.HourlyPrice,
        monthlyPrice: workspace.MonthlyPrice,
        optimalMonthlyHours: workspace.OptimalMonthlyHours,
        runningMode: workspace.Mode,
        processedDate: nowString,
        action: workspace.Action,
        computeType: workspace.WorkspaceProperties.ComputeTypeName,
        billableHours: workspace.BillableHours,
        connectedHours: workspace.ConnectedHours,
        utilisation: workspace.Utilisation,
        meanUsage: workspace.MeanUsage,
        medianUsage: workspace.MedianUsage,
        maxUsage: workspace.MaxUsage,
        usageCost: workspace.UsageCost,
        savings: workspace.Savings
      });
    }

    await parquetWriter.close();

    console.log("[INFO] Writing parquet file to: s3://%s/%s", config.s3Bucket, s3Path);

    const fileContent = fs.readFileSync(localFile);

    var putRequest = {
      Bucket: config.s3Bucket,
      Key: s3Path,
      Body: fileContent,
      ContentType: "application/parquet"
    };

    var response = await s3.putObject(putRequest).promise();

    console.log("[INFO] S3 upload is complete");

    // TODO upsert partition into Glue    
  }
  catch (error)
  {
    console.log("[ERROR] Failed to create Parquet file", error);
    throw error;
  }
}

