import chalk from 'chalk';

type TextStyler = (text: string) => string;

const tuiWrap = (tag: string): TextStyler => (text: string) => `{${tag}}${text}{/${tag}}`;

export const theme = {
  text: {
    muted: chalk.gray,
    info: chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    heading: chalk.blue,
    strong: chalk.bold,
  },
  status: {
    open: chalk.greenBright,
    inProgress: chalk.cyan,
    blocked: chalk.redBright,
    completed: chalk.white,
  },
  priority: {
    critical: chalk.redBright,
    high: chalk.yellowBright,
    medium: chalk.blueBright,
    low: chalk.gray,
  },
  tui: {
    colors: {
      lightText: 'white',
    },
    text: {
      muted: tuiWrap('gray-fg'),
      info: tuiWrap('cyan-fg'),
      success: tuiWrap('green-fg'),
      warning: tuiWrap('yellow-fg'),
      error: tuiWrap('red-fg'),
      shellCommand: tuiWrap('214-fg'),
      shellOutput: tuiWrap('white-fg'),
    },
    status: {
      open: tuiWrap('green-fg'),
      inProgress: tuiWrap('cyan-fg'),
      blocked: tuiWrap('red-fg'),
      completed: tuiWrap('white-fg'),
    },
  },
} as const;
