


exports.handler = (event, context, callback) => {
    console.log('Processing CloudWatch scheduled event:', JSON.stringify(event, null, 2));

    callback(null, 'Finished');
};