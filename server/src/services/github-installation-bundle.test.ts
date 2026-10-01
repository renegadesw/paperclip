import { describe, it, expect } from 'vitest';
import { installationToken, installationTokens } from './github-installation-bundle.js';
const bundle = 'vgit1.' + Buffer.from(JSON.stringify([{id:'2',owner:'renegadesw',token:'fake-org'},{id:'3',owner:'dawgflymd',token:'fake-personal'}])).toString('base64url');
describe('GitHub App installation selection', () => {
 it('selects the requested owner and preserves ordinary credentials', () => {
  expect(installationToken(bundle,{owner:'dawgflymd',repo:'sonar-crew'})).toBe('fake-personal');
  expect(installationToken(bundle,{owner:'RENEGADESW'})).toBe('fake-org');
  expect(installationToken(bundle,{query:'repo:dawgflymd/sonar-crew render'})).toBe('fake-personal');
  expect(installationToken('ordinary-token',{owner:'dawgflymd'})).toBe('ordinary-token');
  expect(installationTokens('ordinary-token')).toBeNull();
 });
 it('refuses missing owners and malformed bundles without exposing credentials', () => {
  expect(()=>installationToken(bundle,{owner:'missing'})).toThrow('not installed');
  expect(()=>installationToken('vgit1.invalid')).toThrow('credentials are invalid');
 });
});
import { loadGitHubGrantMetadata } from './tool-access.js';
it('discovers both installation repository sets without treating a bot as a user', async () => {
 const request = (async (url: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  if (path.startsWith('/users/')) return Response.json({id:1,login:'renegade-agents[bot]'});
  const personal = new Headers(init?.headers).get('authorization') === 'Bearer fake-personal';
  return Response.json({repository_selection:'all',repositories:[{id:personal?3:2,full_name:personal?'dawgflymd/sonar-crew':'renegadesw/vector',owner:{login:personal?'dawgflymd':'renegadesw',type:personal?'User':'Organization'}}]});
 }) as typeof fetch;
 const result = await loadGitHubGrantMetadata(bundle,request,'renegade-agents',{installationId:'2'});
 expect(result.installationIds).toEqual(['2','3']);
 expect(result.repositories.map(r=>r.fullName)).toEqual(['renegadesw/vector','dawgflymd/sonar-crew']);
 expect(result.tokenKind).toBe('installation');
 expect(JSON.stringify(result)).not.toContain('fake-personal');
});
