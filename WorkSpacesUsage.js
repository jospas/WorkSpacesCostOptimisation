var fs = require('fs');
var sprintf = require('sprintf-js').sprintf;

var AWS = require('aws-sdk');
var awsworkspaces = null;
var awscloudwatch = null;

var splunkLogger = require("splunk-logging").Logger;

/**
 * Program entry point that looks up all workspaces and
 * their usage and works out if swapping billing mode 
 * will save costs.
 */
async function run () 
{
  try
  {
    // Find out the config file to use
    var configFile = getConfigFile();

    // Load the config file
    var config = JSON.parse(fs.readFileSync(configFile));

    // Processes the config computing the optimal usage plan
    processConfig(config);

    // Set the region from config
    AWS.config.update({region: config.region});

    // If we are using a profile credentials provider, enable it
    if (config.profile)
    {
      var credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
      AWS.config.credentials = credentials;
    }

    // Initialise AWS components post region and credentials setup
    awsworkspaces = new AWS.WorkSpaces();
    awscloudwatch = new AWS.CloudWatch();

    var workspaces = null;

    // In simulation mode load up the serialised workspaces file
    if (config.simulate)
    {
      workspaces = JSON.parse(fs.readFileSync(config.outputWorkspacesFile));
      console.log(sprintf('[INFO] Loaded: %d simulated workspaces', workspaces.length));
    }
    else
    {
      // Loads the workspaces and metrics from the AWS account
      workspaces = await getWorkSpaces(config);      

      // Load  usage from CloudWatch
      await getWorkSpacesUsage(config, workspaces);

      // Save the workspaces to disk for later
      fs.writeFileSync(config.outputWorkspacesFile, 
        JSON.stringify(workspaces, null, '  '));

      // Log to Splunk HEC if configured
      await logToSplunk(config, workspaces);      

      // Log total potential savings
      console.log(sprintf('[INFO] Total potential monthly savings: $%.2f', config.TotalSavings));
      console.log(sprintf('[INFO] Total potential yearly savings: $%.2f', config.TotalSavings * 12.0));     
    }

    // Convert billing modes if requested and write out the script
    // for manual conversion
    await convertBillingModes(config, workspaces);

    // Success
    process.exit(0);

  }
  catch (error)
  {
    console.log('\n[ERROR] ' + error.message);
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
    throw new Error('Usage: node WorkSpacesUage.js <config file>');
  }

  return commandLine[0];
}

/**
 * Converts billing mode for all workspaces if configured
 */
async function convertBillingModes(config, workspaces)
{
  var outputScript = '#!/bin/bash\n\n';

  var convertedWorkspaces = 0;

  try
  {
    for (var i = 0; i < workspaces.length; ++i)
    {
      var workspace = workspaces[i];

      printProgress(sprintf('[INFO] Converting billing modes: %.0f%%', i * 100.0 / workspaces.length));

      if (workspace.Action === 'CONVERT')
      {
        if (config.convertBillingMode)
        {
          await convertBillingMode(config, workspace);
          convertedWorkspaces++;  
        }

        outputScript += createUpdateScriptLine(config, workspace);
      }
    }

    if (config.outputBillingScript)
    {
      fs.writeFileSync(config.outputBillingScript, outputScript);
      console.log('\n[INFO] Wrote update billing script to: ' + 
        config.outputBillingScript);
    }
  }
  catch (error)
  {
    throw error;
  }

  console.log('[INFO] Successfully converted billing model for ' + 
    convertedWorkspaces + ' workspaces');
}

/**
 * Creates a line in a script to update billing mode
 */
function createUpdateScriptLine(config, workspace)
{
  if (workspace.Action !== 'CONVERT')
  {
    return '';
  }

  var profileOption = '';

  if (config.profile)
  {
    profileOption = '--profile ' + config.profile;
  }

  var newBillingMode = '';

  if (workspace.Mode === 'MONTHLY')
  {
    newBillingMode = 'RunningMode=AUTO_STOP';
  }
  else if (workspace.Mode === 'HOURLY')
  {
    newBillingMode = 'RunningMode=ALWAYS_ON';
  }

  return sprintf('echo "[INFO] Convert instance: [%s] user: [%s] current mode: [%s]"\n' +
    'echo "[INFO] Connected hours: %d"\n' +
    'echo "[INFO] Potential savings: %.2f USD"\n' +
    'echo "[INFO] Last day of month: %s"\n' +
    'aws workspaces modify-workspace-properties %s ' +
    '--workspace-id %s --region %s ' +
    '--workspace-properties %s\n\n',
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
async function convertBillingMode(config, workspace)
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

      if (workspace.Mode === 'MONTHLY')
      {
        params.WorkspaceProperties.RunningMode = 'AUTO_STOP';
      }
      else if (workspace.Mode === 'HOURLY')
      {
        params.WorkspaceProperties.RunningMode = 'ALWAYS_ON';
      }
      else
      {
        throw new Error('Unhandled workspaces billing mode: ' + workspace.Mode);
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
  throw new Error('Failed to convert workspace, maximum retry count exceeded: ' + lastError.message);
}

/**
 * Processes the config computing optimal monthly hours
 */
function processConfig(config)
{
  for (var i = 0; i < config.bundles.length; i++)
  {
    var bundle = config.bundles[i];
    var crossOverHours = 0;
    var baseCost = bundle.hourlyBasePrice;

    while (baseCost < bundle.monthlyPrice)
    {
      baseCost += bundle.hourlyPrice;
      crossOverHours++;
    }

    bundle.optimalMonthlyHours = crossOverHours;

    /**
     * Monthly pro-rata charge assumes 30 days in a month
     */
    bundle.monthlyPricePerHour = bundle.monthlyPrice / 720.0;

    console.log('[INFO] Processed bundle:\n%s',
        JSON.stringify(bundle, null, '  '));
  }

  if (config.convertBillingMode)
  {
    console.log('[WARNING] convertBillingMode is currently disabled');
    config.convertBillingMode = false;
  }

  console.log('[INFO] Last day of month: ' + config.lastDayOfMonth);

  config.TotalSavings = 0.0;
}

/**
 * Locate a configured bundle by bundleId
 */
function getBundle(config, workspace)
{
  var found = config.bundles.find(function(bundle) {
    return bundle.bundleId === workspace.BundleId;
  });

  if (found)
  {
    return found;
  }
  else
  {
    throw new Error('Configuration is missing definition for bundle: ' 
      + JSON.stringify(workspace, null, '  '));
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
function analyseResults(config, workspace)
{
  var runningMode = workspace.WorkspaceProperties.RunningMode;
  var bundle = getBundle(config, workspace);

  workspace.Mode = '';
  workspace.Action = 'KEEP';
  workspace.Savings = 0.0;

  workspace.HourlyCost = bundle.hourlyBasePrice + workspace.ConnectedHours * bundle.hourlyPrice;
  workspace.MonthlyCost = bundle.monthlyPrice;

  /**
   * Convert hourly billing to monthly if the current use plus the
   * monthly pro-rata amount exceeds the monthly cost
   */
  if (runningMode === 'AUTO_STOP')
  {
    workspace.UsageCost = workspace.HourlyCost;
    workspace.Mode = 'HOURLY';

    if (workspace.ConnectedHours >= bundle.optimalMonthlyHours)
    {
      workspace.Action = 'CONVERT';
      workspace.Savings = workspace.HourlyCost - bundle.monthlyPrice;
    }
  }
  /**
   * Convert monthly billing back to hourly only at the end
   * of the month and only if the utilisation is low
   */
  else if (runningMode === 'ALWAYS_ON')
  {
    workspace.UsageCost = bundle.monthlyPrice;
    workspace.Mode = 'MONTHLY';
    if (config.lastDayOfMonth && (workspace.ConnectedHours < bundle.optimalMonthlyHours))
    {
      workspace.Action = 'CONVERT';
      workspace.Savings = bundle.monthlyPrice - workspace.HourlyCost;
    }
  }

  var line = sprintf('%s,%s,%.2f,%.2f,%.2f,%d,' +
      '%s,%s,%s,%s,%s,%s,%s,' +
      '%d,%.2f,' +
      '%d,%d,%d,' +
      '%s,%.2f\n',

    bundle.bundleId, 
    bundle.description, 
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

  fs.appendFileSync(config.outputSummaryFile, line);
}

/**
 * sleeping and backing off if we get throttled
 */
async function getWorkspacesPage(params)
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
  throw new Error('Failed to list workspaces, maximum retry count exceeded: ' + lastError.message);
}

/**
 * Loads information about all workspaces
 */
async function getWorkSpaces(config)
{

  var params = {
    DirectoryId: config.directoryId
  };

  var results = [];

  try
  {
    var response = await getWorkspacesPage(params);
    results = results.concat(response.Workspaces);
    printProgress('[INFO] Workspaces loaded: ' + results.length);

    while (response.NextToken)
    {
      params.NextToken = response.NextToken;
      response = await getWorkspacesPage(params);
      results = results.concat(response.Workspaces);
      printProgress('[INFO] Workspaces loaded: ' + results.length);
    }

    console.log('');

    return results;
  }
  catch (error)
  {
    console.log('\n[ERROR] Failed to retrieve workspaces', error);
    throw error;
  }
}

/**
 * Loads usage for all WorkSpaces from CloudWatch
 */
async function getWorkSpacesUsage(config, workspaces)
{
  var results = [];

  fs.writeFileSync(config.outputSummaryFile, 
    'BundleId,Description,'+
    'HourlyBasePrice,HourlyPrice,MonthlyPrice,OptimalMonthlyHours,' +
    'DirectoryId,WorkSpaceId,UserName,ComputerName,' +
    'State,ComputeType,CurrentMode,' +
    'ConnectedHours,UsageCost,' +
    'MaxUsage,MedianUsage,MeanUsage,' +
    'Action,Savings\n');

  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      /**
       * A set that is used to yrack hourly usage
       */
      var usageSet = new Set();

      var connectedHours = await getWorkSpaceUsage(config, workspaces[i]);
      workspaces[i].ConnectedHours = connectedHours;

      analyseResults(config, workspaces[i]);
      printProgress(sprintf('[INFO] Loading connected user metrics: %.0f%%', 
        i * 100.0 / workspaces.length));
    }

    console.log('');
  }
  catch (error)
  {
    throw error;
  }
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
async function getWorkSpaceUsage(config, workspace)
{
  var maxRetries = 10;
  var retry = 0;
  var lastError = null;

  var startDate = getStartDate();
  var endDate = new Date();

  var params = {
    Dimensions: [],
    Namespace: 'AWS/WorkSpaces',
    StartTime: startDate,
    EndTime: endDate,
    Period: 3600
  };

  params.Dimensions = params.Dimensions.concat({
    Name: 'WorkspaceId',
    Value: workspace.WorkspaceId,
  });

  params.MetricName = 'UserConnected';
  params.Statistics = ['Maximum'];

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

  throw new Error('Failed to load workspace utilisation, maximum retry count exceeded: ' + lastError.message);
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

async function logToSplunk(config, workspaces)
{
  if (!config.splunk || !config.splunk.enabled)
  {
    console.log('[INFO] Skipping Splunk logging');
    return;
  }

  try
  {

    var config = {
        token: config.splunk.token,
        url: config.splunk.url,
        batchInterval: 1000,
        maxBatchCount: 10,
        maxBatchSize: 1024 // 1kb
    };
   
    var logger = new splunkLogger(config);
    
    console.log("[INFO] Starting to sending Splunk data");

    for (var i = 0; i < workspaces.length; i++)
    {
      var payload = {
        message: workspaces[i]
      };

      logger.send(payload);
    }

    await sleep(5000);

    console.log("[INFO] Sending Splunk data is complete");
  }
  catch (error)
  {
    console.log('\n[ERROR] Failed to log to Splunk', error);
    throw error;
  }
}

/**
 * Register the command line entry point
 */
if (require.main == module)
{
  run();
}

/**
 * Print progress to console
 */
function printProgress(message){
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(message);
}
