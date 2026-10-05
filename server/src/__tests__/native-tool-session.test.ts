import {describe,it,expect,vi} from 'vitest';
import {createToolGatewayService,type ToolGatewaySession} from '../services/tool-gateway.js';

describe('private native connector authentication',()=>{
 const session=():ToolGatewaySession=>({id:'native:actual',token:'',companyId:'company',agentId:'source-agent',runId:null,issueId:null,projectId:null,actorType:'agent',actorId:'source-agent',responsibleUserId:'local-board:source-installation',nativeOwnerId:'canonical-owner',nativeSessionId:'actual',nativeInstallationId:'fd-native',createdAt:new Date(),expiresAt:new Date(Date.now()+60000)});
 it('refuses native tokens when the trusted resolver is absent',async()=>{
  const gateway=createToolGatewayService({} as never);
  await expect(gateway.listToolsForSession('native:actual')).rejects.toMatchObject({status:401,reasonCode:'native_session_unavailable'});
 });
 it.each([{runId:'invented-run'},{actorType:'system'},{actorId:'another-agent'},{nativeSessionId:'other'},{nativeOwnerId:null},{responsibleUserId:null},{gatewayId:'gateway'},{expiresAt:new Date(0)}])('refuses an inconsistent native identity snapshot %j',async change=>{
  const gateway=createToolGatewayService({} as never,{nativeSessionResolver:async()=>({...session(),...change} as ToolGatewaySession)});
  await expect(gateway.listToolsForSession('native:actual')).rejects.toMatchObject({status:401,reasonCode:'native_session_unavailable'});
 });
 it('revalidates every call and refuses a revoked native session before tool lookup',async()=>{
  const resolver=vi.fn(async()=>null);
  const gateway=createToolGatewayService({} as never,{nativeSessionResolver:resolver});
  await expect(gateway.listToolsForSession('native:actual')).rejects.toMatchObject({status:401});
  await expect(gateway.executeTool({sessionToken:'native:actual',tool:'db_exec',parameters:{}})).rejects.toMatchObject({status:401});
  expect(resolver).toHaveBeenCalledTimes(2);
 });
 it('refuses retired self and plugin tools even when native identity is valid',async()=>{
  const query:any=new Proxy({}, {get(_target,key){return key==='then'?(resolve:any)=>resolve([]):()=>query;}});
  const db={select:()=>query} as never;
  const gateway=createToolGatewayService(db,{nativeSessionResolver:async()=>session(),pluginToolDispatcher:{listToolsForAgent:()=>[{name:'retired-plugin',description:'fixture',parametersSchema:{type:'object'},pluginId:'plugin'}]} as never});
  for(const tool of ['paperclip-self:list_my_issues','retired-plugin','search_tools','run_tool']){
   await expect(gateway.executeTool({sessionToken:'native:actual',tool,parameters:{}})).rejects.toMatchObject({status:404,reasonCode:'tool_not_found'});
  }
 });
});
