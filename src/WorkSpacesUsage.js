var fs = require('fs');
var sprintf = require('sprintf-js').sprintf;

var AWS = require('aws-sdk');
AWS.config.update({region:'ap-southeast-2'});
var credentials = new AWS.SharedIniFileCredentials({profile: 'workspaces'});
AWS.config.credentials = credentials;
var s3 = new AWS.S3();
var workspaces = new AWS.WorkSpaces();
var cloudwatch = new AWS.CloudWatch();

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

    // Loads the workspaces
    var workspaces = await getWorkSpaces(config);

    // Load  usage from CloudWatch
    await getWorkSpacesUsage(config, workspaces);

    // Save the workspaces to disk for later
    fs.writeFileSync(config.outputWorkspacesFile, 
      JSON.stringify(workspaces, null, '  '));

    // Log total potential savings
    console.log(sprintf('[INFO] Total potential monthly savings: $%.2f', config.TotalSavings));
    console.log(sprintf('[INFO] Total potential yearly savings: $%.2f', config.TotalSavings * 12.0));

    // Convert billing modes if requested
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
  if (!config.convertBillingMode)
  {
    console.log('[INFO] Not converting billing modes as disabled by configuration');
    return;
  }

  var convertedWorkspaces = 0;

  try
  {
    for (var i = 0; i < workspaces.length; ++i)
    {
      var workspace = workspaces[i];

      printProgress(sprintf('[INFO] Converting billing modes: %.0f%%', i * 100.0 / workspaces.length));

      if (workspace.Action === 'CONVERT')
      {
        await convertBillingMode(config, workspace);
        convertedWorkspaces++;
      }
    }
  }
  catch (error)
  {
    throw error;
  }

  console.log('\n[INFO] Successfully converted billing model for ' + 
    convertedWorkspaces + ' workspaces');
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

      await workspaces.modifyWorkspaceProperties(params).promise();
      return;
    }
    catch (error)
    {
      lastError = error;
      sleep(getSleepTime(retry));     
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

    console.log('Processed bundle:\n%s',
        JSON.stringify(bundle, null, '  '));
  }

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
 * Analyses the results of the last n days
 */
function analyseResults(config, workspace)
{
  var runningMode = workspace.WorkspaceProperties.RunningMode;
  var bundle = getBundle(config, workspace);

  workspace.Mode = '';
  workspace.Action = 'KEEP';
  workspace.Savings = 0.0;
  workspace.Cost = 0.0;

  if (runningMode === 'AUTO_STOP')
  {
    workspace.Mode = 'HOURLY';
    workspace.Cost = bundle.hourlyBasePrice + workspace.BillableHours * bundle.hourlyPrice;
    if (workspace.BillableHours > bundle.optimalMonthlyHours)
    {
      workspace.Action = 'CONVERT';
      workspace.Savings = workspace.Cost - bundle.monthlyPrice;
    }
  }
  else if (runningMode === 'ALWAYS_ON')
  {
    workspace.Mode = 'MONTHLY';
    workspace.Cost = bundle.monthlyPrice;
    if (workspace.BillableHours < bundle.optimalMonthlyHours)
    {
      workspace.Action = 'CONVERT';
      workspace.Savings = bundle.monthlyPrice - (bundle.hourlyBasePrice + workspace.BillableHours * bundle.hourlyPrice);
    }
  }

  var line = sprintf('%s,%s,%d,%.2f,%.2f,%.2f,%s,%s,%s,%s,%s,%s,%s,%d,%.2f,%s,%.2f\n',
    bundle.bundleId, 
    bundle.description, 
    bundle.optimalMonthlyHours,
    bundle.monthlyPrice,
    bundle.hourlyBasePrice,
    bundle.hourlyPrice,
    workspace.DirectoryId,
    workspace.WorkspaceId,
    workspace.UserName,
    workspace.ComputerName,
    workspace.State,
    workspace.WorkspaceProperties.ComputeTypeName,
    workspace.Mode,
    workspace.BillableHours,
    workspace.Cost,
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
      var response = await workspaces.describeWorkspaces(params).promise();
      return response;
    }
    catch (error)
    {
      lastError = error;
      sleep(getSleepTime(retry));     
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

    results.concat(response.Workspaces);

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
    'BundleId,Description,OptimalMonthlyHours,' +
    'MonthlyPrice,HourlyBasePrice,HourlyPrice,' +
    'DirectoryId,WorkSpaceId,UserName,ComputerName,' +
    'State,ComputeType,Mode,Hours,Cost,Action,Savings\n');

  try
  {
    for (var i = 0; i < workspaces.length; i++)
    {
      var billableHours = await getWorkSpaceUsage(config, workspaces[i]);
      workspaces[i].BillableHours = billableHours;
      analyseResults(config, workspaces[i]);
      printProgress(sprintf('[INFO] Loading usage metrics: %.0f%%', 
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
 * Loads CloudWatch metrics for a workspace
 * and backing off and retrying if required
 */
async function getWorkSpaceUsage(config, workspace)
{
  var maxRetries = 10;
  var retry = 0;
  var lastError = null;

  var runningMode = workspace.WorkspaceProperties.RunningMode;
  var startDate = new Date();
  var endDate = new Date();
  startDate.setDate(startDate.getDate() - config.daysToEvaluate);

  var params = {
    Dimensions: [],
    Namespace: 'AWS/WorkSpaces',
    StartTime: startDate,
    EndTime: endDate,
    Period: 3600
  };

  params.Dimensions = params.Dimensions.concat({
    Name: 'WorkspaceId',
    Value: workspace.WorkspaceId
  });

  if (runningMode === 'AUTO_STOP')
  {
    params.MetricName = 'Stopped';
    params.Statistics = ['Minimum'];
  }
  else if (runningMode === 'ALWAYS_ON')
  {
    params.MetricName = 'InSessionLatency';
    params.Statistics = ['Maximum'];
  }
  else
  {
    throw new Error('Unhandled running mode found for Workspace: ' + runningMode);
  }

  while (retry < maxRetries)
  {
    try
    {
      var metrics = await cloudwatch.getMetricStatistics(params).promise();

      var billableTime = 0;

      if (runningMode === 'AUTO_STOP')
      {
        for (var m = 0; m < metrics.Datapoints.length; m++)
        {
          if (metrics.Datapoints[m].Minimum == 0)
          {
            billableTime++;
          }
        }
      }
      else if (runningMode === 'ALWAYS_ON')
      {
        for (var m = 0; m < metrics.Datapoints.length; m++)
        {
          billableTime++;
        }
      }

      return billableTime;
    }
    catch (error)
    {
      lastError = error;
      sleep(getSleepTime(retry));     
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
