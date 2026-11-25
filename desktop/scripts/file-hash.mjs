import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
export async function sha256File(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
