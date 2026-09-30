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
// EventSource cannot send an Authorization header, so an Activity reads the live stream with fetch and reconnects itself.
export function bearerEventSource(url,token) {
  const listeners=new Map(),controller=new AbortController(),source={onopen:null,onerror:null,close:()=>controller.abort(),addEventListener:(name,fn)=>listeners.set(name,fn)};
  (async()=>{
    while(!controller.signal.aborted){
      try{
        const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:controller.signal});
        if(!response.ok||!response.body)throw new Error(`http_${response.status}`);
        source.onopen?.();
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        for(;;){
          const {value,done}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
          let end;while((end=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
            let name='message';const data=[];
            for(const line of block.split('\n')){if(line.startsWith('event:'))name=line.slice(6).trim();else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}
            if(data.length)listeners.get(name)?.({data:data.join('\n')});
          }
        }
      }catch{if(controller.signal.aborted)return;}
      source.onerror?.();
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  })();
  return source;
}
