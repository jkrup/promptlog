// Runs the promptlog viewer for the demo recording on [::1] (this Mac's lo0 has no 127.0.0.1).
// usage: node demo/serve.ts <repo-dir> [port]
import { createViewerServer } from '../src/viewer/server.ts';

const cwd = process.argv[2] ?? process.cwd();
const port = Number(process.argv[3] ?? 4810);
const { server, setPort } = createViewerServer({ cwd });
setPort(port);
server.listen(port, '::1', () => process.stdout.write(`viewer: http://[::1]:${port}/\n`));
