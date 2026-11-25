import {execFileSync} from 'node:child_process';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

export const STORE_BUNDLE_ID='com.docuflex.editor';

/** Decode a Mac App Store provisioning profile and check it fits this app. */
export function readProvisioningProfile(path,bundleId=STORE_BUNDLE_ID){
 const plist=execFileSync('security',['cms','-D','-i',resolve(path)]);
 // The profile holds <date> and <data> values that plutil cannot turn into
 // JSON as a whole, so read only the keys that are checked.
 const read=(key,format='raw')=>{
  try{return execFileSync('plutil',['-extract',key,format,'-o','-','-'],{input:plist,encoding:'utf8',stdio:['pipe','pipe','ignore']}).trim();}
  catch{return '';}
 };
 const team=read('TeamIdentifier.0');
 const appId=read('Entitlements.com\\.apple\\.application-identifier');
 if(!team||appId!==`${team}.${bundleId}`)throw Error(`The provisioning profile is for ${appId||'another app'}, not ${team}.${bundleId}.`);
 if(read('ProvisionsAllDevices')==='true'||read('ProvisionedDevices','json'))throw Error('Use a Mac App Store Connect (distribution) profile, not a development profile.');
 const expires=new Date(read('ExpirationDate'));
 if(!(expires>new Date()))throw Error('The provisioning profile has expired.');
 return {team,appId,name:read('Name'),expires};
}

/** The signing identity's Team ID, from "Apple Distribution: Name (TEAMID)". */
export function identityTeam(identity){return /\(([A-Z0-9]{10})\)\s*$/.exec(identity)?.[1]||'';}

/** Embed the profile and write main-app entitlements that carry the Team ID. */
export async function prepareStoreSigning(app,profilePath,identity,baseEntitlements){
 const {team,appId}=readProvisioningProfile(profilePath);
 if(identityTeam(identity)!==team)throw Error(`The signing identity belongs to team ${identityTeam(identity)||'?'}, the profile to ${team}.`);
 await copyFile(resolve(profilePath),join(app,'Contents/embedded.provisionprofile'));
 const directory=await mkdtemp(join(tmpdir(),'docuflex-store-'));
 const entitlements=join(directory,'Entitlements.plist');
 const extra=`<key>com.apple.application-identifier</key><string>${appId}</string><key>com.apple.developer.team-identifier</key><string>${team}</string>`;
 await writeFile(entitlements,(await readFile(baseEntitlements,'utf8')).replace('</dict>',extra+'</dict>'));
 return {entitlements,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

/** Check that the installer-signing certificate is named right and installed. */
export function assertInstallerIdentity(installerIdentity){
 if(!/^(3rd Party Mac Developer Installer:|Mac Installer Distribution:)/.test(installerIdentity||''))throw Error('Set APPLE_INSTALLER_IDENTITY to the installed "3rd Party Mac Developer Installer" (Mac Installer Distribution) certificate.');
 // Installer certificates are not code-signing identities, so list them all.
 const identities=execFileSync('security',['find-identity','-v'],{encoding:'utf8'});
 if(!identities.includes('"'+installerIdentity+'"'))throw Error('The installer signing identity is not installed or is not valid.');
 return installerIdentity;
}

/** Wrap the signed app in the installer package App Store Connect accepts. */
export function buildStorePackage(app,output,installerIdentity){
 assertInstallerIdentity(installerIdentity);
 execFileSync('productbuild',['--sign',installerIdentity,'--component',resolve(app),'/Applications',resolve(output)],{stdio:'inherit'});
 execFileSync('pkgutil',['--check-signature',resolve(output)],{stdio:'inherit'});
}
