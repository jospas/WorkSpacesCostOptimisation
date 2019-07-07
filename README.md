# Amazon WorkSpaces Cost Optimisation

Provides a simple Node.js script that allows inspection of Amazon WorkSpaces usage and conversion of billing modes to reduce costs.

This is a Node.js conversion of the existing project that provides a full deployable solution to AWS but for one off usage by customers:

- [WorkSpaces Cost Optimizer](https://docs.aws.amazon.com/solutions/latest/workspaces-cost-optimizer/welcome.html)

## Environment setup

This is a Node.js script so you will need Node.js (and NPM installed):

- [Install Node for your Platform](https://nodejs.org/en/download/)

Run the command to fetch the dependencies locally:

	npm install

## Credentials

You will either need to run the script on an EC2 instance using an appropriate role or locally with a named profile.

You will require the following minimum IAM policy:

	  {
	    "Version": "2012-10-17",
	    "Statement":[
	      {
	        "Effect":"Allow",
	        "Action":["workspaces:DescribeWorkspaces",
	          "workspaces:ModifyWorkspaceProperties"],
	        "Resource":"*"
	      },
	      {
	        "Effect":"Allow",
	        "Action":["cloudwatch:GetMetricStatistics"],
	        "Resource":"*"
	      }
	    ]
	  }
 
## Configuration

Clone the config/example.json configuration file locally and open in an editor.

	  {
	    "directoryId": "XXXXXXXX",
	    "region": "ap-southeast-2",
	    "profile": "workspaces",
	    "daysToEvaluate": 30,
	    "outputSummaryFile": "usage.csv",
	    "outputWorkspacesFile": "workspaces.json",
	    "convertBillingMode": false,
	    "bundles": [
	      {
	        "bundleId": "XXXXXXXX",
	        "description": "Standard",
	        "hourlyPrice": 0.39,
	        "hourlyBasePrice": 14.00,
	        "monthlyPrice": 45.00
	      }    
	    ]
	  }
  
Edit the AWS region code (for example: ap-southeast-2), Amazon WorkSpaces directory id and remove or edit the profile name as required.  

You will need to define a bundle object for every deployed bundle, entering the appropriate pricing for the bundle (you can ignore additional allocated storage as this does not affect the billing mode).

- [Amazon WorkSpaces Pricing Page](https://aws.amazon.com/workspaces/pricing/)

Initially, run the program with the config setting:

	"convertBillingMode": false

This will produce a csv file into:

	"outputSummaryFile": "usage.csv"
  
The csv has data that shows the deployed WorkSpace instances and recommendations around potential cost savings.

Investigate this file before enabling automatic billing conversion.

## Cost implications

When converting monthly billing instances to hourly instances the change actually takes effect at the start of the next month.

When converting to monthly instances from hourly instances, the existing hourly usage is still charged (including the base cost) and a pro-rata monthly fee is applied based on the number of days left in the month.

For more information see:

- [Amazon WorkSpaces FAQ - Billing and Pricing](https://aws.amazon.com/workspaces/faqs/#Billing_and_Pricing)

## Running the script

Run the script using this command, passing your config file of choice:

	node WorkSpaceUsage.js config/example.json

The script will produce a CSV file containing the raw data, a JSON file containing data about current WorkSpace instances.

It also produces some summary estimates of potential savings for example:

	[INFO] Total potential monthly savings: $4557.69
	[INFO] Total potential yearly savings: $54692.28
  
If billing conversion is disabled by configuration you will see:

	[INFO] Not converting billing modes as disabled by configuration
  
Otherwise the system outputs statistics of converted instances.