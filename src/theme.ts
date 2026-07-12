import chalk from 'chalk';

export const theme = {
  text: {
    muted: chalk.gray,
    info: chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    heading: chalk.blue,
    strong: chalk.bold,
    readyYes: chalk.green,
    readyNo: chalk.hex('#FFA500'),
  },
  // Blocked status override: always red, regardless of stage
  blocked: chalk.redBright,
  // Stage-progression colours: gray → blue → cyan → yellow → green → white
  stage: {
    idea: chalk.gray,
    intakeComplete: chalk.blue,
    planComplete: chalk.cyan,
    inProgress: chalk.yellow,
    inReview: chalk.green,
    done: chalk.white,
  },
  priority: {
    critical: chalk.redBright,
    high: chalk.yellowBright,
    medium: chalk.blueBright,
    low: chalk.gray,
  },
} as const;
