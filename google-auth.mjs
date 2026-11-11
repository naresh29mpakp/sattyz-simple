import * as oidc from 'openid-client';
import {createHash,randomBytes} from 'node:crypto';

const digest=v=>createHash('sha256').update(v).digest('hex');
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const metadata={issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']};

/** One owner, one-time browser-bound flows; tokens stay in memory only. */
export function createGoogleAuth({clientId,clientSecret,redirectUri,transport,clock=Date.now,flowStore}){
 const configured=!!(clientId&&clientSecret&&redirectUri),pending=new Map();
 let config;
 if(configured){
  const url=new URL(redirectUri);
  if(url.pathname!=='/api/google/callback'||url.search||url.hash||url.username||url.password)throw error('Google redirect URI must end in /api/google/callback without query or credentials');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw error('Google sign-in requires HTTPS outside loopback');
  config=new oidc.Configuration(metadata,clientId,clientSecret);config.timeout=15;
  if(transport)config[oidc.customFetch]=transport;
  oidc.enableNonRepudiationChecks(config);
 }
 function prune(){for(const [k,v]of pending)if(v.expires<=clock())pending.delete(k);}
 const flows=flowStore||{async reserve(key,value){prune();if(pending.size>=100)return false;pending.set(key,value);return true;},async take(key){prune();const flow=pending.get(key);pending.delete(key);return flow;}};
 return {
  configured,
  async start(linkOwner=null){
   if(!configured)throw error('Google sign-in needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on the server.',503);
   const state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier(),browserToken=randomBytes(32).toString('base64url');
   if(!await flows.reserve(digest(state),{nonce,verifier,browserHash:digest(browserToken),expires:clock()+300000,linkOwner}))throw error('Too many sign-in attempts. Please try again shortly.',429);
   const url=oidc.buildAuthorizationUrl(config,{scope:'openid email profile',response_type:'code',redirect_uri:redirectUri,state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',prompt:'select_account'});
   return {url:url.href,browserToken,secure:new URL(redirectUri).protocol==='https:'};
  },
  async finish(callbackUrl,browserToken){
   if(!configured)throw error('Google sign-in is not configured.',503);
   const url=new URL(callbackUrl),state=url.searchParams.get('state');
   if(!state||!browserToken)throw error('Sign-in expired or the browser cookie is missing. Please start again.');
   const key=digest(state),flow=await flows.take(key);
   if(!flow||flow.expires<=clock()||flow.browserHash!==digest(browserToken))throw error('Sign-in expired or did not start in this browser. Please start again.');
   let claims;
   try{const tokens=await oidc.authorizationCodeGrant(config,url,{pkceCodeVerifier:flow.verifier,expectedState:state,expectedNonce:flow.nonce,idTokenExpected:true});claims=tokens.claims();}catch{throw error('Google could not verify this sign-in. Please start again.',401);}
   if(!claims||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255||claims.email_verified!==true||typeof claims.email!=='string')throw error('A verified Google account is required.',403);
   return {subject:claims.sub,email:claims.email,name:typeof claims.name==='string'?claims.name.slice(0,100):'Owner',linkOwner:flow.linkOwner};
  }
 };
}
