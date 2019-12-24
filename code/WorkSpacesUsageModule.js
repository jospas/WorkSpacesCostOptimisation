var fs = require("fs");
var sprintf = require("sprintf-js").sprintf;
var AWS = require("aws-sdk");
var axios = require("axios");

/**
 * Processes the config
 */
exports.processConfig = function(config)
{
  if (config.convertBillingMode)
  {
    console.log("[WARNING] convertBillingMode is currently disabled");
    config.convertBillingMode = false;
  }

  console.log("[INFO] Last day of month: " + config.lastDayOfMonth);

  config.TotalSavings = 0.0;
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
        if (config.convertBillingMode)
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

  console.log("[INFO] Successfully converted billing model for: " + 
    convertedWorkspaces + " workspaces");

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
    "ConnectedHours,UsageCost," +
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
      var params = {
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
  throw new Error("Failed to convert workspace, maximum retry count exceeded: " + lastError.message);
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
function getDaysLeftInMonth(inputDate)
{
  var daysInMonth = getDaysInMonth(inputDate);
  return daysInMonth - inputDate.getDate();
}

/**
 * Fetches the number of days in a month
 */
function getDaysInMonth(inputDate)
{
  return new Date(inputDate.getFullYear(), inputDate.getMonth() + 1, 0).getDate();
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

  workspace.HourlyCost = bundle.hourlyBasePrice + workspace.ConnectedHours * bundle.hourlyPrice;
  workspace.MonthlyCost = bundle.monthlyPrice;

  /**
   * Convert hourly billing to monthly if the current use plus the
   * monthly pro-rata amount exceeds the monthly cost
   */
  if (runningMode === "AUTO_STOP")
  {
    workspace.UsageCost = workspace.HourlyCost;
    workspace.Mode = "HOURLY";

    if (workspace.ConnectedHours >= bundle.optimalMonthlyHours)
    {
      workspace.Action = "CONVERT";
      workspace.Savings = workspace.HourlyCost - bundle.monthlyPrice;
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
      workspace.Savings = bundle.monthlyPrice - workspace.HourlyCost;
    }
  }

  var line = sprintf("%s,%s,%.2f,%.2f,%.2f,%d," +
      "%s,%s,%s,%s,%s,%s,%s," +
      "%d,%.2f," +
      "%d,%d,%d," +
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
 * Pacific Time (UTC -07:00) but I am using local time here 
 * or this fails on the 1st on the month in forward timezones
 * like Australia.
 */
function getStartDate()
{
  var now = new Date();
  var startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return startDate;
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
  var endDate = new Date();

  var params = {
    Dimensions: [],
    Namespace: "AWS/WorkSpaces",
    StartTime: startDate,
    EndTime: endDate,
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
      workspace.DailyUsage.length = getDaysInMonth(new Date());
      workspace.DailyUsage.fill(0);

      for (var m = 0; m < metrics.Datapoints.length; m++)
      {
        if (metrics.Datapoints[m].Maximum > 0)
        {
          // Track daily aggregate usage (in UTC)
          var when = new Date(metrics.Datapoints[m].Timestamp);
          workspace.DailyUsage[when.getDate() - 1]++;

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
function printProgress(config, message) {
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
function printProgressDivider(config) {
  if (process.stdout.isTTY)
  {
    console.log("");
  }
}

