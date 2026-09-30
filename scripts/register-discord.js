const c={discordClientId:process.env.DISCORD_CLIENT_ID||'',discordClientSecret:process.env.DISCORD_CLIENT_SECRET||''};if(!c.discordClientId||!c.discordClientSecret)throw Error('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
const tokenResponse=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.discordClientId,client_secret:c.discordClientSecret,scope:'applications.commands.update'}),signal:AbortSignal.timeout(10000)});
if(!tokenResponse.ok)throw Error(`Command credential request failed: HTTP ${tokenResponse.status}`);const authorization=await tokenResponse.json();
const guild=process.env.DISCORD_TEST_GUILD_ID;
const route=guild?`applications/${c.discordClientId}/guilds/${guild}/commands`:`applications/${c.discordClientId}/commands`;
// POST creates or updates this command by name without bulk-overwriting unrelated app commands.
const response=await fetch(`https://discord.com/api/v10/${route}`,{method:'POST',headers:{Authorization:`Bearer ${authorization.access_token}`,'Content-Type':'application/json'},
  body:JSON.stringify({name:'jev',description:'Play a game against JEV',type:1,contexts:[0],integration_types:[0],options:[{type:1,name:'sudoku',description:'Race JEV on independent Sudoku boards'}]}),signal:AbortSignal.timeout(10000)});
if(!response.ok)throw Error(`Command registration failed: HTTP ${response.status}`);const result=await response.json();console.log(JSON.stringify({registered:result.name,id:result.id,scope:guild?'test_guild':'global'}));
