/**
  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
  
  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  A copy of the License is located at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
  or in the "license" file accompanying this file. This file is distributed 
  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either 
  express or implied. See the License for the specific language governing 
  permissions and limitations under the License.
*/

var AWS = require('aws-sdk');
AWS.config.update({region: process.env.REGION});  
var amazonS3 = new AWS.S3();
var moment = require("moment");

/**
 * Looks in S3 and loads the available data files
 */
exports.handler = async (event, context, callback) => {

    var responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': 'application/json'
    };

    try
    {

      var nowUTC = moment.utc();
      console.log("[INFO] Starting loading workspaces at: " + nowUTC.format());

      var config = createConfig();

      // List the S3 bucket parsing the file names
      var workspaceData = [];

      var params = {
        Bucket: config.bucket,
        Prefix: config.keyPrefix
      };

      var listResponse = await amazonS3.listObjectsV2(params).promise();

      for (var i = 0; i < listResponse.Contents.length; i++) 
      {
        var item = listResponse.Contents[i];

        var signParams = {
            Bucket: config.bucket,
            Key: item.Key,
            Expires: 60 * 60 * 10
        };

        const url = amazonS3.getSignedUrl('getObject', signParams);

        var data = 
        {
          name: item.Key.substring(item.Key.lastIndexOf('/') + 1),
          url: url,
        };

        let nameRegex = /^workspaces_(?<year>[0-9]{4})_(?<month>[0-9]{2}).*/;
        var match = data.name.match(nameRegex);

        if (match)
        {
          data.year = match.groups.year;
          data.monthName = moment(match.groups.month, 'MM').format('MMMM');
          data.monthIndex = match.groups.month;
          data.yearMonth = data.year + '' + data.monthIndex;

          if (nowUTC.format('YYYY') == data.year && nowUTC.format('MM') == data.monthIndex)
          {
            data.latest = true;
          }
          else
          {
            data.latest = false;
          }

          workspaceData.push(data);
        }
      }

      const response = {
          statusCode: 200,
          headers: responseHeaders,
          body: JSON.stringify({  "workspaces": workspaceData })
      };

      callback(null, response);
    }
    catch (error)
    {
        console.log("[ERROR] Failed to load workspace data from S3", error);
        const response = {
            statusCode: 500,
            headers: responseHeaders,
            body: JSON.stringify({  "message": "Failed to load workspace data from S3: " + error })
        };
        callback(null, response);
    }
};

/**
 * Creates configuration from environment variables
 */
function createConfig()
{
    var config = {};

    config.region = process.env.REGION;
    config.bucket = process.env.BUCKET;
    config.keyPrefix = process.env.KEY_PREFIX;

    console.log("[INFO] Made configuration: %s", JSON.stringify(config, null, "  "));

    return config;
}
