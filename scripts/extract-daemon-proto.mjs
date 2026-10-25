// Extracts the protobuf definitions of sing-box's API service (daemon/started_service.proto)
// from a sing-box binary and writes them as a protobufjs JSON bundle used by the app.
//
// Go embeds every compiled .proto as a raw FileDescriptorProto, so the definitions always
// match the binary they were taken from. Re-run after updating sing-box:
//   node scripts/extract-daemon-proto.mjs [path/to/sing-box.exe]
// Default path: <APPDATA>/sing-box-client/core/sing-box.exe
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');
const descriptor = require('protobufjs/ext/descriptor');

const PROTO_FILE = 'daemon/started_service.proto';
const binary =
  process.argv[2] ??
  path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? '', '.local/share'), 'sing-box-client', 'core', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
const output = path.join(import.meta.dirname, '..', 'src', 'app', 'core', 'daemon', 'daemon.proto.json');

const data = fs.readFileSync(binary);

function readVarint(buf, i) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, i];
  }
}

/** A FileDescriptorProto starts with field 1 (name); walk its top-level fields to find the end. */
function extractDescriptor(name) {
  const marker = Buffer.concat([Buffer.from([0x0a, name.length]), Buffer.from(name)]);
  const start = data.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found in ${binary}`);
  let i = start;
  while (i < data.length) {
    const [tag, next] = readVarint(data, i);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field < 1 || field > 14 || (wire !== 0 && wire !== 2)) break;
    let j = next;
    if (wire === 0) [, j] = readVarint(data, j);
    else {
      const [length, k] = readVarint(data, j);
      j = k + length;
    }
    i = j;
  }
  return data.subarray(start, i);
}

const file = descriptor.FileDescriptorProto.decode(extractDescriptor(PROTO_FILE));
// The only external dependency is google.protobuf.Empty; supply it so types resolve.
const empty = { name: 'google/protobuf/empty.proto', package: 'google.protobuf', messageType: [{ name: 'Empty' }] };
const root = protobuf.Root.fromDescriptor({ file: [empty, file] });

const bundle = { source: `${PROTO_FILE} from ${path.basename(binary)}`, ...root.toJSON() };
fs.writeFileSync(output, JSON.stringify(bundle, null, 1) + '\n');
const service = root.lookupService('daemon.StartedService');
console.log(`wrote ${path.relative(process.cwd(), output)}: ${Object.keys(service.methods).length} methods`);
