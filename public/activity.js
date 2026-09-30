// Runs only when Discord launches the game as an Activity (the URL carries frame_id).
// The SDK is vendored at /vendor/ because the page's CSP allows scripts from this origin only.
export async function signInWithDiscord(api) {
  const {DiscordSDK}=await import('/vendor/discord-embedded-app-sdk.js');
  const {clientId}=await api('/api/activity/config');
  const sdk=new DiscordSDK(clientId);
  await sdk.ready();
  const {code}=await sdk.commands.authorize({client_id:clientId,response_type:'code',state:'',prompt:'none',scope:['identify']});
  const session=await api('/api/activity/session',{method:'POST',body:{code}});
  await sdk.commands.authenticate({access_token:session.accessToken});
  return {token:session.token,csrf:session.csrf,user:session.user};
}
