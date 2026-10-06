import './styles.css';
// Must stay before anything that creates a zod schema (see the module).
import './shared/zod-config';
import { start } from './app/start';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');
void start(container);
