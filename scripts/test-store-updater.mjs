import {afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'svelte/store';
import {supportsDirectUpdates,checkForUpdate,downloadUpdate,installUpdate,update} from '../src/lib/updater.js';
afterEach(()=>{delete globalThis.window;update.set({phase:'idle',info:null,received:0,total:0,error:'',visible:false});});
function desktop(distribution){const calls=[];globalThis.window={__DOCUFLEX_DISTRIBUTION__:distribution,__TAURI__:{core:{invoke:async(name)=>{calls.push(name);return{current:'0.9.6',latest:'0.9.6',available:false};}}}};return calls;}
test('the Store distribution performs no update RPCs, including manual checks and direct download/install calls',async()=>{
 const calls=desktop('app-store');assert.equal(supportsDirectUpdates(),false);
 await checkForUpdate();await checkForUpdate({manual:true});await downloadUpdate();await installUpdate();
 assert.deepEqual(calls,[]);assert.equal(get(update).visible,false);assert.equal(get(update).phase,'idle');
});
test('the existing direct-download distribution retains its native update check',async()=>{
 const calls=desktop('direct');assert.equal(supportsDirectUpdates(),true);await checkForUpdate({manual:true});
 assert.deepEqual(calls,['docuflex_update_check']);assert.equal(get(update).phase,'current');assert.equal(get(update).visible,true);
});
test('older direct desktop shells remain compatible and the website/server never tries native updates',async()=>{
 assert.equal(supportsDirectUpdates(),false);await checkForUpdate({manual:true});
 const calls=desktop(undefined);await checkForUpdate();assert.deepEqual(calls,['docuflex_update_check']);
});
