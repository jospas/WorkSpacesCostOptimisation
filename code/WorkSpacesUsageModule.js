var fs = require("fs");
var sprintf = require("sprintf-js").sprintf;
var AWS = require("aws-sdk");
var axios = require("axios");
var moment = require("moment");

/**
 * Processes the config
 */
exports.processConfig = function(config)
{
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

  if (owner)
  {
    console.log("[INFO] Loading workspaces bundles for owner: " + owner);  
  }
  else
  {
    console.log("[INFO] Loading customer workspaces bundles");
  }
  

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

  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      var connectedHours = await getWorkSpaceUsage(config, awscloudwatch, workspaces[i]);
      workspaces[i].ConnectedHours = connectedHours;

      analyseResults(config, workspaces[i], bundles);
      printProgress(config, sprintf("[INFO] Loading connected user metrics: %.0f%%", 
        i * 100.0 / workspaces.length));
    }

    printProgressDivider(config);
  }
  catch (error)
  {
    throw error;
  }
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
  workspace.StartOfMonth = getStartDate().format();
  workspace.EndOfMonth = getEndDate().format();

  var hourlyCost = bundle.hourlyBasePrice + workspace.ConnectedHours * bundle.hourlyPrice;

  if (runningMode === "AUTO_STOP")
  {
    workspace.Mode = "HOURLY";
    workspace.UsageCost = hourlyCost;
  }
  else if (runningMode === "ALWAYS_ON")
  {
    workspace.UsageCost = bundle.monthlyPrice;
    workspace.Mode = "MONTHLY";
  }

  /**
   * Make a judgement on whether an instance should be converted
   * or not
   */
  computeBestFitAndAction(workspace);
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
  return moment.utc().startOf('month').add(-7, 'hours');
}

/**
 * Fetches the end of the workspaces billing month
 * which should be midnight on the lastday of the month in
 * Pacific Time (UTC -07:00)
 */
function getEndDate()
{
  return moment.utc().endOf('month').add(-7, 'hours');
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
          // Track daily aggregate usage (in UTC) offset by 7 hours to make this align with
          // the billing month -7 UTC
          var when = moment.utc(metrics.Datapoints[m].Timestamp).add(7, 'hours');
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
 * Compute the line of best fit and recommended actions
 * See: http://bl.ocks.org/benvandyke/8459843
 */
function computeBestFitAndAction(workspace)
{
    var xSeries = [];
    var ySeries = [];

    var cumulativeUse = 0;
    var hours = 0;

    // if (workspace.BillableHours < 72)
    // {
    //   workspace.HasPrediction = false;
    //   workspace.Action = 'KEEP';
    //   workspace.ActionReason = 'Insufficient data to make prediction';
    //   workspace.ActionConfidence = 0.0;
    //   return;
    // }

    workspace.DailyUsage.forEach(usage =>{
      if (hours < (workspace.BillableHours + 12))
      {
        cumulativeUse += usage;
        ySeries.push(cumulativeUse);
        hours += 24;
      }
    });

    // Use at most the last 7 days of data
    var startBillableHours = Math.max(0, workspace.BillableHours - 24 * 7);
    var currentBillableHours = 0;
    var xSeriesClamped = [];
    var ySeriesClamped = [];

    var day = 1;

    ySeries.forEach(y => {
        if (currentBillableHours >= startBillableHours)
        {
            xSeriesClamped.push(day); 
            ySeriesClamped.push(y);  
        }

        xSeries.push(day); 
        ySeries.push(y);  
        currentBillableHours += 24;
        day++;
    });

    if (xSeriesClamped.length < 3)
    {
      workspace.HasPrediction = false;
      workspace.Action = 'KEEP';
      workspace.ActionReason = 'Insufficient data to make prediction';
      workspace.ActionConfidence = 0.0;
      return;
    }

    var leastSquaresCoeff = leastSquares(xSeriesClamped, ySeriesClamped);

    var x1 = 1;
    var y1 = leastSquaresCoeff[0] + leastSquaresCoeff[1];

    if (leastSquaresCoeff[0] != 0)
    {
        var intersectionPoint = (workspace.OptimalMonthlyHours - leastSquaresCoeff[1]) / 
        leastSquaresCoeff[0];
        workspace.HasPrediction = true;
        workspace.LeastSquaresData = leastSquaresCoeff;
        workspace.PredictedCrossOver = +intersectionPoint.toFixed(1);
        workspace.PredictionConfidence = leastSquaresCoeff[2].toFixed(2);
    }
    else
    {
        workspace.HasPrediction = true;
        workspace.LeastSquaresData = leastSquaresCoeff;
        workspace.PredictedCrossOver = 10000;
        workspace.PredictionConfidence = 1.0;
    }

    /**
     * Hourly actions
     */
    if (workspace.Mode === 'HOURLY')
    {
      if (workspace.ConnectedHours >= workspace.OptimalMonthlyHours)
      {
        workspace.Action = 'CONVERT';
        workspace.ActionReason = 'Hourly usage exceeds monthly billing threshold';
        workspace.ActionConfidence = 1.0;
      }
      else if (workspace.ConnectedHours == 0)
      {
        workspace.Action = 'MONITOR';
        workspace.ActionReason = 'Consider termination as instance has zero use';
        workspace.ActionConfidence = workspace.PredictionConfidence;
      }      
      else
      {
        if (workspace.PredictionConfidence >= 0.7)
        {
          if (workspace.PredictedCrossOver < workspace.DailyUsage.length - 2)
          {
            workspace.Action = 'CONVERT';
            workspace.ActionReason = 'Predicted usage exceeds monthly billing threshold';
            workspace.ActionConfidence = workspace.PredictionConfidence;
          }
          else
          {
            workspace.Action = 'KEEP';
            workspace.ActionReason = 'Predicted usage is below monthly billing threshold';
            workspace.ActionConfidence = workspace.PredictionConfidence;
          }
        }
        else
        {
          workspace.Action = 'KEEP';
          workspace.ActionReason = 'Prediction has low confidence';
          workspace.ActionConfidence = workspace.PredictionConfidence;
        }
      }
    }
    /**
     * Monthly actions
     */
    else if (workspace.Mode === 'MONTHLY')
    {
      if (workspace.ConnectedHours >= workspace.OptimalMonthlyHours)
      {
        workspace.Action = 'KEEP';
        workspace.ActionReason = 'Monthly usage exceeds monthly billing threshold';
        workspace.ActionConfidence = 1.0;
      }
      else if (workspace.ConnectedHours == 0)
      {
        workspace.Action = 'MONITOR';
        workspace.ActionReason = 'Consider conversion to hourly or termination at end of month';
        workspace.ActionConfidence = workspace.PredictionConfidence;
      }
      else
      {
        if (workspace.PredictionConfidence >= 0.7)
        {
          if (workspace.PredictedCrossOver < workspace.DailyUsage.length - 2)
          {
            workspace.Action = 'KEEP';
            workspace.ActionReason = 'Predicted usage exceeds monthly billing threshold';
            workspace.ActionConfidence = workspace.PredictionConfidence;
          }
          else
          {
            workspace.Action = 'MONITOR';
            workspace.ActionReason = 'If usage remains low, consider conversion to hourly';
            workspace.ActionConfidence = workspace.PredictionConfidence;
          }
        }
        else
        {
          workspace.Action = 'KEEP';
          workspace.ActionReason = 'Prediction has low confidence';
          workspace.ActionConfidence = workspace.PredictionConfidence;
        }
      }
    }
}

/**
 * Computes least squares on an x and y data series
 */
function leastSquares(xSeries, ySeries) 
{
  var reduceSumFunc = function(prev, cur) { return prev + cur; };
  
  var xBar = xSeries.reduce(reduceSumFunc) * 1.0 / xSeries.length;
  var yBar = ySeries.reduce(reduceSumFunc) * 1.0 / ySeries.length;

  var ssXX = xSeries.map(function(d) { return Math.pow(d - xBar, 2); })
      .reduce(reduceSumFunc);
  
  var ssYY = ySeries.map(function(d) { return Math.pow(d - yBar, 2); })
      .reduce(reduceSumFunc);
      
  var ssXY = xSeries.map(function(d, i) { return (d - xBar) * (ySeries[i] - yBar); })
      .reduce(reduceSumFunc);
      
  var slope = ssXY / ssXX;
  var intercept = yBar - (xBar * slope);
  var rSquare = Math.pow(ssXY, 2) / (ssXX * ssYY);

  return [slope, intercept, rSquare];
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
