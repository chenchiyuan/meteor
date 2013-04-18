// with autopublish on: publish all fields to the logged in user;
// only the user's meetup user id
Accounts._autopublishFields.loggedInUser.push('services.meetup');
Accounts._autopublishFields.allUsers.push('services.meetup.id');

Accounts.oauth.registerService('meetup', 2, function(query) {

  var accessToken = getAccessToken(query);
  var identity = getIdentity(accessToken);

  return {
    serviceData: {
      id: identity.id,
      accessToken: accessToken
    },
    options: {profile: {name: identity.name}}
  };
});

var getAccessToken = function (query) {
  var config = Accounts.loginServiceConfiguration.findOne({service: 'meetup'});
  if (!config)
    throw new Accounts.ConfigError("Service not configured");

  var result = Meteor.http.post(
    "https://secure.meetup.com/oauth2/access", {headers: {Accept: 'application/json'}, params: {
      code: query.code,
      client_id: config.clientId,
      client_secret: config.secret,
      grant_type: 'authorization_code',
      redirect_uri: Meteor.absoluteUrl("_oauth/meetup?close"),
      state: query.state
    }});
  if (result.error) { // if the http response was an error
    throw new Error("Failed to complete OAuth handshake with Meetup. " +
                    "HTTP Error " + result.statusCode + ": " + result.content);
  } else if (result.data.error) { // if the http response was a json object with an error attribute
    throw new Error("Failed to complete OAuth handshake with Meetup. " + result.data.error);
  } else {
    return result.data.access_token;
  }
};

var getIdentity = function (accessToken) {
  var result = Meteor.http.get(
    "https://secure.meetup.com/2/members",
    {params: {member_id: 'self', access_token: accessToken}});
  if (result.error) {
    throw new Error("Failed to fetch identity from Meetup. " +
                    "HTTP Error " + result.statusCode + ": " + result.content);
  } else {
    return result.data.results && result.data.results[0];
  }
};
