async function authorize() {
  const payload = JSON.stringify({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: process.env.DJ_APP_CLIENT_ID,
    AuthParameters: {
      USERNAME: process.env.AUTH_USERNAME,
      PASSWORD: process.env.AUTH_PASSWORD,
    },
  });

  try {
    const res = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: payload,
    });
    const result = await res.json();
    return result;
  } catch (error) {
    console.error(`Error connecting to cognito.\n
                  Assuming Auth turned off for local testing.`);
    return {
      AuthenticationResult: {
        AccessToken: `Couldn't connect to cognito`,
      },
    };
  }
}

async function get_access_token() {
  const auth_result = await authorize();
  return auth_result.AuthenticationResult.AccessToken;
}

module.exports = get_access_token;
