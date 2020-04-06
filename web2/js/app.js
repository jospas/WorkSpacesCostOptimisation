/**
  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
  
  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  A copy of the License is located at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
  or in the "license" file accompanying this file. This file is distributed 
  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either 
  express or implied. See the License for the specific language governing 
  permissions and limitations under the License.
*/

var siteConfig = null;
var table = null;
var workspaces = null;
var availableData = null;
var selectedDataPack = null;
var singleUsageChart = null;

/**
 * Formats a date for display
 */
function formatDate(date) 
{
    var d = new Date(date),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;

    return [year, month, day].join('-');
}

/**
 * Formats a date time for display
 */
function formatDateTime(date) 
{
    var d = new Date(date),
        month = '' + (d.getMonth() + 1),
        day = '' + d.getDate(),
        year = d.getFullYear(),
        hours = '' + d.getHours(),
        minutes = '' + d.getMinutes();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    if (hours.length < 2) hours = '0' + hours;
    if (minutes.length < 2) minutes = '0' + minutes;

    return [year, month, day].join('-') + ' ' + [hours, minutes].join(':');
}

/**
 * Get a signed put URL for this file
 */
function getSignedUrl(file)
{	
	var api = siteConfig.api_base + siteConfig.api_upload + '/' + file.name;
	console.log('[INFO] fetching signed url from: ' + api);

	let axiosConfig = {
		headers: {
			'Content-Type': 'application/json;charset=UTF-8',
			'X-Api-Key': localStorage.apiKey
		}
	};

	return axios.get(api, axiosConfig);
}

/**
 * Logs the user out
 */
function logout()
{
	window.localStorage.removeItem("apiKey");
	document.location.href = '';
}

/**
 * Highlights the current nav
 */
function highlightNav(navId)
{
	$('.nav-link').removeClass('active');
	$(navId).addClass('active');
}

/**
 * Renders the nav bar
 */
function renderNavBar()
{
	var nav = '<li class="nav-item"><a id="homeLink" class="nav-link" href="#">Home</a></li>';

	if (window.localStorage.apiKey)
	{
		nav += '<li class="nav-item"><a id="dashboardLink" class="nav-link" href="#dashboard">Dashboard</a></li>';
		nav += '<li class="nav-item"><a id="recommendationsLink" class="nav-link" href="#recommendations">Recommendations</a></li>';
		nav += '<li class="nav-item"><a id="idleInstancesLink" class="nav-link" href="#idleInstances">Idle instances</a></li>';
		nav += '<li class="nav-item"><a id="allInstancesLink" class="nav-link" href="#allInstances">All instances</a></li>';		
		nav += '<li class="nav-item"><a id="logoutLink" class="nav-link" onclick="javascript:logout();">Log out</a></li>';
	}
	else
	{
		nav += '<li class="nav-item"><a id="loginLink" class="nav-link" href="#login">Log in</a></li>';
	}

	document.getElementById('navBar').innerHTML = nav;
}

/**
 * Sleep for time millis
 */
function sleep(time) 
{
	return new Promise((resolve) => setTimeout(resolve, time));
}

/**
 * Handles dynamic routing from pages craeted post load
 */
function dynamicRoute(event)
{
	event.preventDefault();
	const pathName = event.target.hash;
	console.log('[INFO] navigating dynamically to: ' + pathName);
	router.navigateTo(pathName);
}

function getUrlVars() 
{
  var vars = {};
  var parts = window.location.href.replace(/[?&]+([^=&]+)=([^&]*)/gi, function(m,key,value) {
      vars[key] = value;
  });
  return vars;
}

function dataPackChanged()
{
	var selected = $('#dataPacksSelect').val();
	selectDataPack(selected);
}

function selectDataPack(dataPack)
{
	console.log('Changing data pack to: ' + dataPack);
	window.localStorage.dataPack = dataPack;
	selectedDataPack = getSelectedDataPack();
	console.log("Selected data pack: " + JSON.stringify(selectedDataPack, null, "  "));

	var href = window.location.href;

	if (href.includes('&pack='))
	{
		href = href.substring(0, href.indexOf('&pack='));
	}
	else if (href.includes('?pack='))
	{
		href = href.substring(0, href.indexOf('?pack='));
	}

	if (href.includes('?'))
	{
		window.location.href = href + '&pack=' + dataPack;
	}
	else
	{
		window.location.href = href + '?pack=' + dataPack;
	}
}

function getSelectedDataPack()
{
	var filtered = availableData.filter(item => item.yearMonth === window.localStorage.dataPack);

	if (filtered.length == 0)
	{
		selectDataPack(availableData[0].yearMonth);
		return getSelectedDataPack();
	}

	return filtered[0];
}

function useLatestChanged()
{
	var useLatest = $('#useLatest').is(":checked");
	window.localStorage.selectLatest = useLatest;

	$('#dataPacksSelect').prop("disabled", useLatest);

	if (useLatest)
	{
		selectDataPack(availableData[0].yearMonth);
	}
}

function renderDataPacksSelect()
{
	var select = $('#dataPacksSelect');

	var html = "";

	for (var i = 0; i < availableData.length; i++)
	{
		var item = availableData[i];

		if (item.yearMonth === selectedDataPack.yearMonth)
		{
			html += '<option value="' + item.yearMonth + '" selected="selected">' + item.monthName + ' ' + item.year + '</option>\n'
		}
		else
		{
			html += '<option value="' + item.yearMonth + '">' + item.monthName + ' ' + item.year + '</option>\n'
		}
	}

	select.html(html);

	$('#dataPacksSelect').prop('disabled', window.localStorage.selectLatest == 'true');
	$('#useLatest').prop('checked', window.localStorage.selectLatest == 'true');
}

/**
 * Finds available data packs in S3 via API Gateway
 */
async function loadAvailableData()
{
	try
	{
		let axiosConfig = {
			headers: {
				'X-Api-Key': localStorage.apiKey
		  }
		};
		var response = await axios.get(siteConfig.availableDataUrl, axiosConfig);
		var availableWorkspaceData = response.data;

		var rest = availableWorkspaceData.workspaces.filter(item => !item.latest);

		availableWorkspaceData.workspaces.sort((a, b) => {
			return (a.yearMonth > b.yearMonth) ? -1 : ((b.yearMonth > a.yearMonth) ? 1 : 0)
		});

		availableData = availableWorkspaceData.workspaces;

		console.log('Loaded available data: ' + JSON.stringify(availableData, null, "  "));

		if (!window.localStorage.selectLatest)
		{
			window.localStorage.selectLatest = true;
		}

		if (window.localStorage.selectLatest == true)
		{
			selectDataPack(availableData[0].yearMonth);
		}

		if (!window.localStorage.dataPack)
		{
			selectDataPack(availableData[0].yearMonth);
		}

		selectedDataPack = getSelectedDataPack();
		console.log("Selected data pack: " + JSON.stringify(selectedDataPack, null, "  "));
	}
	catch (error)
	{
		console.log('Failed to load available data: ' + error);
		throw error;
	}
}

/**
 * Loads remote compressed workspaces file from S3 using a signed URL
 */
async function loadWorkspaces(url)
{
	try
	{
		let axiosConfig = {
			responseType: 'arraybuffer'
		};
		var response = await axios.get(url, axiosConfig);
		var workspacesStr = pako.inflate(response.data, { to: 'string' });
		var workspaces = JSON.parse(workspacesStr);
		console.log('[INFO] loaded: ' + workspaces.length + ' workspaces');
		return workspaces;	
	}
	catch (error)
	{
		console.log('Failed to load workspaces: ' + error);
		throw error;
	}
}

function copyScript()
{
  var scriptTextArea = document.getElementById("scriptTextArea");
  scriptTextArea.select();
  document.execCommand('copy');
  scriptTextArea.setSelectionRange(0, 0);
  scriptTextArea.blur(); 
}

function computeConversionScript()
{
  var script = "";

  var profile = $("#awsProfileName").val();

  var instanceCount = 0;

  table.$('input[type="checkbox"]').each(function()
  {
    if (this.checked) 
    {
      var workspaceId = this.value;

      var workspace = workspaces.find(ws => ws.WorkspaceId === workspaceId);

      if (workspace)
      {
        var newBillingMode = "";

        if (workspace.Mode === "MONTHLY")
        {
          newBillingMode = "RunningMode=AUTO_STOP";
        }
        else if (workspace.Mode === "HOURLY")
        {
          newBillingMode = "RunningMode=ALWAYS_ON";
        }

        script += 'aws workspaces modify-workspace-properties';
        script += ' --workspace-id ' + workspace.WorkspaceId;
        script += ' --region ' + siteConfig.region;
        script += ' --workspace-properties ' + newBillingMode;

        if (profile != '')
        {
          script += ' --profile ' + profile;            
        }

        script += '\n';

        instanceCount++;
      }
    }
  });

  if (script === '')
  {
    script = 'echo "No instances selected"';
  }

  $('#conversionScriptTitle').text("Convert billing mode script - " + instanceCount + " instance(s)");
  $('#scriptTextArea').val(script);
}

function createConversionScript()
{
  computeConversionScript();
  $("#conversionScriptDialog").modal();
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
      computeType = "UNKNOWN";
    }
  }

  return computeType
}

function computeCost(workspace)
{
  if (workspace.Mode == "HOURLY")
  {
    let cost = workspace.HourlyBasePrice;
    cost += workspace.HourlyPrice * workspace.ConnectedHours;
    return '$' + cost.toFixed(2);
  }
  else
  {
    let cost = workspace.MonthlyPrice;
    return '$' + cost.toFixed(2);
  }
}

function destroyTable()
{
	if (table)
	{
		table.destroy(true);
		table = null;
	}
}

function createGraphTableDataset(workspaces)
{
  var dataSet = [];

  workspaces.forEach(workspace => {
    var line = [
      '',
      '',
      workspace.WorkspaceId,
      workspace.UserName,
      getComputeType(workspace),
      workspace.Mode,
      computeCost(workspace),
      workspace.ConnectedHours,
      workspace.Action,
      workspace.ActionReason
    ];
    dataSet.push(line);
  });

  return dataSet;
}

function createGraphTable(workspaces, filter)
{
	destroyTable();

  $('#workspacesTable').DataTable( 
  {
    data: createGraphTableDataset(workspaces),
    pageLength: 100,
    order: [[ 6, 'desc' ]],
    columns: [
        { title: '<input type="checkbox" name="select_all" value="1" id="select-all">' },
        { title: '<img src="img/eye_disabled.svg" style="color: grey" width="16" height="16">' },
        { title: "Workspace" },
        { title: "User" },
        { title: "Type" },
        { title: "Mode" },
        { title: "Cost" },
        { title: "Hours" },
        { title: "Action" },
        { title: "Reason" }
    ],
    columnDefs: [
    {
      // https://www.gyrocode.com/articles/jquery-datatables-how-to-add-a-checkbox-column/
      targets: 0,
      searchable: false,
      orderable: false,
      className: 'dt-body-center',
      render: function (data, type, full, meta) {
        if (type === 'export')
        {
          return '';
        }
        else
        {
           return '<input type="checkbox" name="id[]" value="' + full[2] + '">';
        }
      }
    },
    {
      targets: 1,
      searchable: false,
      orderable: false,
      className: 'dt-body-center',
      render: function (data, type, full, meta) {
        if (type === 'export')
        {
          return '';
        }
        else
        {
          return '<img src="img/eye.svg" alt="Graph instance" width="16" height="16" title="Graph instance" onclick="showWorkspaceDialog(\'' + full[2] + '\')">'
        }
      }
    },
    {
      targets: 9,
      render: function (data, type, full, meta) 
      {
        var fullValue = full[9];
        var value = fullValue;

        if (value.length > 35)
        {
          value = value.substring(0, 35) + "...";
        }

        if (type === 'export')
        {
          return fullValue;
        }
        else
        {
          return '<span data-toggle="tooltip" data-placement="left" title="' + fullValue + '">' + value + '</span>';
        } 
      }
    } ],
    dom: 'Blfrtip',
    buttons: 
    [
      {
        text: '<b>Generate Script</b>',
        action: function (e, dt, node, config) 
        {
          createConversionScript();
        },
        exportOptions: { orthogonal: 'export' }
      },      
      {
        extend: 'copy',
        exportOptions: { orthogonal: 'export' }
      },
      {
        extend: 'excel',
        exportOptions: { orthogonal: 'export' }
      },
      {
        extend: 'csv',
        exportOptions: { orthogonal: 'export' }
      }
    ]
  });

  table = $('#workspacesTable').DataTable();

  if (filter && filter.includes("|"))
  {
    var split=filter.split("|");

    if (split.length == 2)
    {
      table.column(split[0]).search(split[1]).draw();
    }
  }

  $('#workspacesTable tbody').on('mouseover', 'tr', function () 
  {
    $('[data-toggle="tooltip"]').tooltip();
  });

  $('#select-all').on('click', function()
  {
    if (!this.checked)
    {
      // Always unselect everything
      var rows = table.rows().nodes();
      $('input[type="checkbox"]', rows).prop('checked', false);
    }
    else
    {
      // Only select filtered results
      var rows = table.rows({ 'search': 'applied' }).nodes();
      $('input[type="checkbox"]', rows).prop('checked', true);
    }
  });

  $('#workspacesTable tbody').on('change', 'input[type="checkbox"]', function()
  {
    if (!this.checked)
    {
       var el = $('#select-all').get(0);
       if (el && el.checked && ('indeterminate' in el))
       {
          el.indeterminate = true;
       }
    }
  });

  // Listen AWS profile name changes
  $('#awsProfileName').on('input', function()
  {
    computeConversionScript();
  });
}

function getSingleUsage(workspace)
{
  var lineColor = 'rgba(0, 0, 255, 0.7)';
  var fillColor = 'rgba(0, 0, 255, 0.1)';

  if (workspace.Mode === 'HOURLY')
  {
    lineColor = 'rgba(40, 219, 15, 0.7)';
    fillColor = 'rgba(40, 219, 15, 0.1)';
  }

  var dataSets = [];

  var dataSet = {
    label: workspace.WorkspaceId,
    borderWidth: 2,
    lineTension: 0,
    fill: false,
    pointRadius: 3,
    pointHitRadius: 4,
    borderColor: lineColor,
    backgroundColor: fillColor,
    data: []
  };
  var cumulativeUse = 0;
  var hours = 0;

  workspace.DailyUsage.forEach(usage =>{
    if (hours < (workspace.BillableHours))
    {
        cumulativeUse += usage;
        dataSet.data.push(cumulativeUse);
        hours += 24;
    }
  });

  dataSets.push(dataSet);

  var optimalUsageDataSet = {
    label: 'Optimal monthly usage',
    borderWidth: 2,
    lineTension: 0,
    fill: false,
    pointStyle: 'line',
    borderColor: 'rgba(255, 0, 0, 0.5)',
    backgroundColor: 'rgba(255, 0, 0, 0.5)',
    pointRadius: 0,
    pointHitRadius: 2,
    data: []
  };

  for (var i = 0; i <= workspace.DailyUsage.length; i++) {
    optimalUsageDataSet.data.push(workspace.OptimalMonthlyHours);
  }

  dataSets.push(optimalUsageDataSet);

  var optimalDailyUse = workspace.OptimalMonthlyHours / workspace.DailyUsage.length;

  var optimalDailyDataSet = {
    label: 'Optimal daily usage',
    borderWidth: 2,
    lineTension: 0,
    fill: false,
    pointStyle: 'line',
    borderColor: 'rgba(255, 165, 0, 0.5)',
    backgroundColor: 'rgba(255, 165, 0, 0.5)',
    pointRadius: 0,
    pointHitRadius: 2,
    data: []
  };

  var optimalDailyUse = workspace.OptimalMonthlyHours / workspace.DailyUsage.length;
  var currentOptimalUsage = optimalDailyUse;    

  for (var i = 0; i < workspace.DailyUsage.length; i++) {
    optimalDailyDataSet.data.push(+currentOptimalUsage.toFixed(1));
    currentOptimalUsage += optimalDailyUse;
  }    

  dataSets.push(optimalDailyDataSet);

  var bestFit = getBestFit(workspace);

  if (bestFit)
  {
    dataSets.push(bestFit);
  }
	console.log('-----------------------------');
  console.log('Billable hours: ' + workspace.BillableHours);
  console.log('Connected hours: ' + workspace.ConnectedHours);
  console.log('Utilisation: ' + workspace.Utilisation);
  console.log('Usage: ' + JSON.stringify(workspace.DailyUsage));
  console.log('ComputeType: ' + JSON.stringify(getComputeType(workspace)));
  console.log('-----------------------------');

  return dataSets;
}

function getBestFit(workspace)
{
  if (!workspace.HasPrediction)
  {
    return null;
  }

  var bestFitDataSet = {
      label: 'Predicted use',
      borderWidth: 2,
      lineTension: 0,
      borderDash: [10,5],
      fill: false,
      pointStyle: 'line',
      borderColor: 'rgba(223, 52, 235, 0.7)',
      backgroundColor: 'rgba(223, 52, 235, 0.7)',
      pointRadius: 0,
      pointHitRadius: 2,
      data: []
  };    

  var x1 = 1;
  var y1 = workspace.LeastSquaresData[0] + workspace.LeastSquaresData[1];

  for (var i = 0; i <= workspace.DailyUsage.length; i++)
  {
      var y = workspace.LeastSquaresData[0] * (i + 1) + workspace.LeastSquaresData[1];

      if (y < 0)
      {
          bestFitDataSet.data.push(0.0);
      }
      else
      {
          bestFitDataSet.data.push(+y.toFixed(1));    
      }
  }

  return bestFitDataSet;
}

/**
 * Creates the graph for a single workspace
 * showing the opimal usage and progression lines
 */
function createSingleChart(workspaceId)
{
  var workspace = workspaces.find(ws => ws.WorkspaceId === workspaceId);

  if (workspace)
  {
    var singleContext = document.getElementById('singleUsage').getContext('2d');

    var graphLabels = [];

    for (var i = 1; i <= workspace.DailyUsage.length; i++) {
      graphLabels.push("" + i);
    }

    if (singleUsageChart)
    {
      singleUsageChart.destroy();
      singleUsageChart = null;
    }

    singleUsageChart = new Chart(singleContext, {
      type: 'line',
      data: {
        labels: graphLabels,
        datasets: getSingleUsage(workspace)
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            boxWidth: 6,
            usePointStyle: true
          }
        },
        scales: {
          yAxes: [{
            ticks: {
              beginAtZero: true
            }
          }]
        }
      }
    });
    return workspace;
  }

  return null;
}

function showWorkspaceDialog(workspaceId)
{
  var workspace = createSingleChart(workspaceId);

  if (workspace)
  {
    $("#workspaceDetailsTitle").text("Amazon Workspace Usage: " + workspace.WorkspaceId + 
      " " + workspace.UserName + " (" + workspace.Mode + ")");
    $("#workspaceAction").text(workspace.Action);
    $("#workspaceActionReason").text(workspace.ActionReason + ' - (confidence ' + 
    		(isNaN(workspace.ActionConfidence) ? 0.0 : workspace.ActionConfidence) + ')')
    $("#workspaceDetailsDialog").modal();
    //console.log('Least squares: ' + JSON.stringify(workspace.LeastSquaresData, null, "  "));
  }
}

/**
 * Fired once on page load, sets up the router
 * and navigates to current hash location
 */
window.addEventListener('load', () =>
{
	/**
	 * Set up the vanilla router
	 */
	var router = new Router({
		mode: 'hash',
		root: '/index.html',
		page404: function (path) 
		{
			console.log('[WARN] page not found: ' + path);
		}
	});

	/**
	 * Get a reference to the application div
	 */
	var appDiv = $('#app');

	Handlebars.registerHelper('ifeq', function (a, b, options) {
	    if (a == b) { return options.fn(this); }
	    return options.inverse(this);
	});

	/**
	 * Load site configuration and Handlebars templates 
	 * and compile them after they are all loaded
	 */
	$.when(
		$.get('site_config.json'),
		$.get('templates/login.hbs'),
		$.get('templates/loading.hbs'),
		$.get('templates/home.hbs'),
		$.get('templates/dashboard.hbs'),
		$.get('templates/recommendations.hbs'),
		$.get('templates/allInstances.hbs'),
		$.get('templates/idleInstances.hbs'),
	).done(function(site, login, loading, home, dashboard, recommendations, allInstances, idleInstances)
	{
		siteConfig = site[0];
		var homeTemplate = Handlebars.compile(home[0]);
		var loginTemplate = Handlebars.compile(login[0]);
		var loadingTemplate = Handlebars.compile(loading[0]);
		var dashboardTemplate = Handlebars.compile(dashboard[0]);
		var recommendationsTemplate = Handlebars.compile(recommendations[0]);
		var allInstancesTemplate = Handlebars.compile(allInstances[0]);
		var idleInstancesTemplate = Handlebars.compile(idleInstances[0]);

		/**
		 * Set up templates and links
		 */
		router.add('', () => {
			highlightNav('#homeLink');
			let html = homeTemplate();
			appDiv.html(html);
		});

		router.add('login', () => {
			highlightNav('#loginLink');
			let html = loginTemplate();
			appDiv.html(html);
		});

		router.add('dashboard', () => {
			highlightNav('#dashboardLink');
			let html = dashboardTemplate();
			appDiv.html(html);
		});

		router.add('recommendations', () => {
			highlightNav('#recommendationsLink');
			let html = recommendationsTemplate();
			appDiv.html(html);
		});

		router.add('allInstances', () => {
			highlightNav('#allInstancesLink');
			let html = allInstancesTemplate();
			appDiv.html(html);
		});

		router.add('idleInstances', () => {
			highlightNav('#idleInstancesLink');			
			let html = idleInstancesTemplate();
			appDiv.html(html);
		});

		/**
		 * Make hash links work
		 */
		router.addUriListener()

		/**
		 * Render the navigation bar
		 */
		renderNavBar();

		/**
		 * Load the current fragment
		 */
		router.check();
	});
});