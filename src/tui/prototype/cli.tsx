#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import App from './App';

const headless = process.env.TUI_DEMO === '1' || process.argv.includes('--demo');

render(React.createElement(App, {headless}));
