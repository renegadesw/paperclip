import base64,json,os,pathlib,runpy,sys,unittest
from unittest.mock import patch
SCRIPT=pathlib.Path(__file__).with_name('managed-gh.py')
BUNDLE='vgit1.'+base64.urlsafe_b64encode(json.dumps([{'id':'2','owner':'renegadesw','token':'fake-org'},{'id':'3','owner':'dawgflymd','token':'fake-personal'}]).encode()).decode().rstrip('=')
class ManagedGhTest(unittest.TestCase):
 def invoke(self,args):
  seen={}
  def execute(binary,argv,env):seen.update(binary=binary,argv=argv,token=env.get('GH_TOKEN'))
  with patch.dict(os.environ,{'PAPERCLIP_GIT_TOKEN':BUNDLE}),patch.object(sys,'argv',['gh']+args),patch('os.execve',execute):runpy.run_path(str(SCRIPT))
  return seen
 def test_explicit_repo(self):self.assertEqual(self.invoke(['repo','view','dawgflymd/sonar-crew'])['token'],'fake-personal')
 def test_rest_repo(self):self.assertEqual(self.invoke(['api','repos/renegadesw/vector'])['token'],'fake-org')
 def test_missing_owner_fails(self):
  with self.assertRaises(SystemExit):self.invoke(['repo','view','missing/repo'])
if __name__=='__main__':unittest.main()
