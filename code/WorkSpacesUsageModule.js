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
};

/**
 * Describes workspaces bundles and computes 
 * hourly and monthly pricing
 */
exports.describeWorkspaceBundles = async function(config, owner, awsworkspaces)
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
    });

    return results;
  }
  catch (error)
  {
    console.log("\n[ERROR] Failed to retrieve bundles", error);
    throw error;
  }
};

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
};

/**
 * Loads usage for all WorkSpaces from CloudWatch
 */
exports.getWorkSpacesUsage = async function(config, awscloudwatch, workspaces, bundles, regionPricing)
{
  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      await getWorkSpaceUsage(config, awscloudwatch, workspaces[i]);
      analyseResults(config, workspaces[i], bundles, regionPricing);
      printProgress(config, sprintf("[INFO] Loading connected user metrics: %.0f%%", 
        i * 100.0 / workspaces.length));
    }

    printProgressDivider(config);
  }
  catch (error)
  {
    throw error;
  }
};

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
 * Loads region pricing from file
 */
exports.getRegionPricing = async function(config)
{
  console.log("[INFO] Loading region pricing from file for: " + config.region);
  var pricingFile = "./pricing/" + config.region + ".json";

  try
  {
    var content = fs.readFileSync(pricingFile);
    console.log("[INFO] Successfully loaded pricing from file for region: " + config.region);
    return JSON.parse(content);
  }
  catch (error)
  {
    console.log("[ERROR] Failed to load pricing for region: " + config.region, error);
    throw error;
  }
};

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

function getComputeType(workspace)
{
  var computeType = workspace.WorkspaceProperties.ComputeTypeName;

  if (!computeType)
  {
    if (workspace.State === 'PENDING')
    {
      computeType = "PENDING"; 
    }
    else
    {
      throw new Error("Failed to locate compute type for workspace: " + JSON.stringify(workspace, null, "  "));
    }
  }
  return computeType;
}

/**
 * Fetches the number of days in a month
 */
function getDaysInMonth()
{
  return moment().utc().daysInMonth();
}

function getRootStorage(workspace)
{
  var size = workspace.WorkspaceProperties.RootVolumeSizeGib;

  if (!size)
  {
    return 0;
  }

  return size;
}

function getUserStorage(workspace)
{
  var size = workspace.WorkspaceProperties.UserVolumeSizeGib;

  if (!size)
  {
    return 0;
  }

  return size;   
}

function getWorkspacePrice(config, workspace, regionPricing, bundle)
{
  console.log('[INFO] Bundle: ' + JSON.stringify(bundle, null, "  "));
  console.log('[INFO] Workspace: ' + JSON.stringify(workspace, null, "  "));
  var os = bundle.Windows ? "windows": "linux";

  var licence = "included";

  if (config.windowsBYOL && bundle.Windows)
  {
    licence = "byol";
  }

  console.log('[INFO] OS: ' + os + " licence: " + licence);
  var computeType = getComputeType(workspace);
  var storage = "storage_" + getRootStorage(workspace) + "_" + getUserStorage(workspace);
  var pricing = {};

  var storageNode = regionPricing.os[os].licence[licence].computeType[computeType].monthly[storage];

  if (!storageNode)
  {
    throw new Error("Failed to locate pricing for workspace: " + JSON.stringify(workspace, null, "  "));
  }

  pricing.hourlyPrice = regionPricing.os[os].licence[licence].computeType[computeType].hourly;
  pricing.hourlyBasePrice = storageNode.hourly;
  pricing.monthlyPrice = storageNode.monthly;
  pricing.optimalMonthlyHours = Math.floor((pricing.monthlyPrice - pricing.hourlyBasePrice) / pricing.hourlyPrice);

  console.log("[INFO] Loaded workspace pricing: " + JSON.stringify(pricing, null, "  "));

  return pricing;
}


/**
 * Analyses the results for a workspace for this year
 */
function analyseResults(config, workspace, bundles, regionPricing)
{
  var runningMode = workspace.WorkspaceProperties.RunningMode;
  var bundle = getBundle(workspace, bundles);
  var pricing = getWorkspacePrice(config, workspace, regionPricing, bundle);

  workspace.Mode = "";
  workspace.Savings = 0.0;

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

  workspace.HourlyBasePrice = pricing.hourlyBasePrice;
  workspace.HourlyPrice = pricing.hourlyPrice;
  workspace.MonthlyPrice = pricing.monthlyPrice;
  workspace.OptimalMonthlyHours = pricing.optimalMonthlyHours;
  workspace.StartOfMonth = getStartDate().format();
  workspace.EndOfMonth = getEndDate().format();

  var hourlyCost = pricing.hourlyBasePrice + workspace.ConnectedHours * pricing.hourlyPrice;

  if (runningMode === "AUTO_STOP")
  {
    workspace.Mode = "HOURLY";
    workspace.UsageCost = hourlyCost;
  }
  else if (runningMode === "ALWAYS_ON")
  {
    workspace.UsageCost = pricing.monthlyPrice;
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
  var maxRetries = 50;
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
  var maxRetries = 50;
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
  var maxRetries = 50;
  var retry = 0;
  var lastError = null;

  var startDate = getStartDate();
  var endDate = moment.utc();

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

      workspace.DailyUsage = [];
      workspace.DailyUsage.length = getDaysInMonth();
      workspace.DailyUsage.fill(0);
      workspace.ConnectedHours = 0;

      for (var m = 0; m < metrics.Datapoints.length; m++)
      {
        if (metrics.Datapoints[m].Maximum > 0)
        {
          // Track daily aggregate usage (in UTC) offset by -7 hours to make this align with
          // the billing month -7 UTC
          var when = moment(metrics.Datapoints[m].Timestamp);
          var hoursSinceStart = Math.abs(when.diff(startDate, 'hours'));
          var daysSinceStart = Math.floor(hoursSinceStart / 24);
          workspace.DailyUsage[daysSinceStart]++;

          // Track a connected hour
          workspace.ConnectedHours++;
        }
      }

      workspace.MaxUsage = Math.max(...workspace.DailyUsage);
      workspace.MedianUsage = median(workspace.DailyUsage);
      workspace.MeanUsage = mean(workspace.DailyUsage);

      return;
    }
    catch (error)
    {
      console.log(error);
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
};

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
    var countAbove = 0;
    var countBelow = 0;
    var optimalUsageSum = 0;
    var optimalDailyHours = workspace.OptimalMonthlyHours / workspace.DailyUsage.length;

    /**
     * Compute cumulative usage
     */
    workspace.DailyUsage.forEach(usage =>{
      if (hours < (workspace.BillableHours + 12))
      {
        cumulativeUse += usage;
        ySeries.push(cumulativeUse);

        optimalUsageSum += optimalDailyHours;

        if (cumulativeUse > optimalUsageSum)
        {
          countAbove++;
        }
        else
        {
          countBelow++;
        }

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
        if (workspace.PredictionConfidence >= 0.8)
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
        else if (countAbove > 0 && countBelow == 0)
        {
            workspace.Action = 'INSPECT';
            workspace.ActionReason = 'Cumulative usage exceeds daily threshold for all days';
            workspace.ActionConfidence = workspace.PredictionConfidence;
        }
        else if (countBelow > 0 && countAbove == 0)
        {
            workspace.Action = 'KEEP';
            workspace.ActionReason = 'Cumulative usage is below daily threshold for all days';
            workspace.ActionConfidence = workspace.PredictionConfidence;
        }
        else
        {
          workspace.Action = 'MONITOR';
          workspace.ActionReason = 'Variable usage and low prediction confidence, monitor usage';
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
        if (workspace.PredictionConfidence >= 0.8)
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
        else if (countBelow > 0 && countAbove == 0)
        {
            workspace.Action = 'MONITOR';
            workspace.ActionReason = 'Cumulative usage below daily threshold for all days';
            workspace.ActionConfidence = workspace.PredictionConfidence;
        }
        else if (countAbove > 0 && countBelow == 0)
        {
            workspace.Action = 'KEEP';
            workspace.ActionReason = 'Monthly usage currently exceeds usage thresholds';
            workspace.ActionConfidence = workspace.PredictionConfidence;
        }
        else
        {
          workspace.Action = 'MONITOR';
          workspace.ActionReason = 'Variable usage and low prediction confidence, monitor usage';
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
    return 2000;
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
