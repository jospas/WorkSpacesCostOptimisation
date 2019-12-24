# Amazon WorkSpaces Cost Optimisation

Provides a simple Node.js script and soon a Lambda function that allows inspection of Amazon WorkSpaces usage and conversion of billing modes to reduce costs.

This is a Node.js conversion of the existing project that provides a full deployable solution to AWS but for one off usage by customers:

- [WorkSpaces Cost Optimizer](https://docs.aws.amazon.com/solutions/latest/workspaces-cost-optimizer/welcome.html)

It adds the enhancement of reduced configuration (automated download of public pricing) and reduces the deployable footprint (can be run as a script and soon as a Lambda function).

## TODO

1. Finish Lambda function deployment and scheduling
2. Track the cost of extra allocated user storage
3. Track WorkSpaces usage over multiple months in S3 or DynamoDB and suggest terminations of under-utilised instances 

## Important Notes

Read the [Amazon WorkSpaces FAQ - Billing and Pricing](https://aws.amazon.com/workspaces/faqs/#Billing_and_Pricing) and [Amazon WorkSpaces Pricing](https://aws.amazon.com/workspaces/pricing/) pages.

**Q: Can I switch between hourly and monthly billing?**

Yes, you can switch from hourly to monthly billing for your Amazon WorkSpaces at any time by switching the running mode to AlwaysOn in the AWS Management Console, or through the Amazon WorkSpaces APIs. When you switch, billing immediately changes from hourly to monthly, and you are charged a prorated amount at the monthly rate for the remainder of the month, along with the monthly and hourly usage fees already billed for the month. Your Amazon WorkSpaces will continue to be charged monthly unless you switch the running mode back to AutoStop.

You can switch from monthly to hourly billing by setting the running mode to AutoStop in the AWS Management Console or through the Amazon WorkSpaces APIs. Switching from monthly to hourly billing will take effect the following month as you will have already paid for your Amazon WorkSpaces for that month. Your Amazon WorkSpaces will continue to be charged hourly unless you switch the running mode back to AlwaysOn. Your Amazon WorkSpaces will continue to be charged hourly unless you switch the running mode back to AlwaysOn. **Please note that billing renewals happen at 00:00 Pacific Time on the first of each month.**

WorkSpaces users can also switch between monthly and hourly billing directly from the WorkSpaces client if this self-service management capability is enabled by their WorkSpaces administrator.

## Environment setup

This is a Node.js script so you will need Node.js (and NPM installed):

- [Install Node for your Platform](https://nodejs.org/en/download/)

Run the command to fetch the dependencies locally:

	npm install

## Credentials

You will either need to run the script on an EC2 instance or install the Lambda function using the provided CloudFormation template using an appropriate role or locally with a named profile.

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
	    "region": "XXXXXXXX",
	    "profile": "workspaces",
	    "windowsBYOL": false
	  }
  
Edit the AWS region code (for example: ap-southeast-2), Amazon WorkSpaces directory id and remove or edit the profile name as required.

If using dedicated hosts and BYOL licensing for Windows, enable the 'windowsBYOL' flag to use BYOL pricing.

## Cost implications

When converting monthly billing instances to hourly instances the change actually takes effect at the start of the next month.

When converting to monthly instances from hourly instances, the existing hourly usage is still charged (including the base cost) and a pro-rata monthly fee is applied based on the number of days left in the month.

For more information see:

- [Amazon WorkSpaces FAQ - Billing and Pricing](https://aws.amazon.com/workspaces/faqs/#Billing_and_Pricing)

## Running the script

Run the script using this command, passing your config file of choice:

	node code/WorkSpacesUsageScript.js config/yourconfig.json

The script will produce the following data files in *./output/*

1. usage.csv - a CSV file containing the raw usage data
2. workspaces.json - a JSON file containing data about current WorkSpaces instances and their daily usage
3. updateBilling.sh - a command line script for making the suggested changes
4. customer_bundes.json - a data file containing the current customer bundles and pricing
5. amazon_bundles.json - a data file containing the current Amazon bundles and pricing
6. public_pricing.json - a simplified pricing file for the current region

It also produces some summary estimates of potential savings for example:

	[INFO] Total potential monthly savings: $4557.69
	[INFO] Total potential yearly savings: $54692.28
