import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const desktopRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function distributionProfile(env=process.env,platform=process.platform){
 const distribution=env.DOCUFLEX_DISTRIBUTION||'direct';
 if(!['direct','app-store'].includes(distribution))throw Error('Unknown desktop distribution.');
 const store=distribution==='app-store';
 if(store&&platform!=='darwin')throw Error('The Mac App Store profile requires macOS.');
 if(store&&env.DOCUFLEX_VARIANT==='redesign')throw Error('The Store profile uses the public Docuflex identity.');
 const localQa=store&&env.DOCUFLEX_APP_STORE_LOCAL_QA==='1';
 return {distribution,store,localQa,port:localQa||env.DOCUFLEX_VARIANT==='redesign'?43137:43127,
  resources:store?join(desktopRoot,'.app-store/resources'):join(desktopRoot,'src-tauri/resources'),
  target:env.CARGO_TARGET_DIR?resolve(env.CARGO_TARGET_DIR):join(desktopRoot,'src-tauri',store?'target-app-store':'target')};
}
