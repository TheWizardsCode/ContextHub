/**
 * Configuration management for Worklog projects
 */
import { WorklogConfig } from './types.js';
/**
 * Get the path to the config directory
 */
export declare function getConfigDir(): string;
/**
 * Get the path to the config file
 */
export declare function getConfigPath(): string;
/**
 * Get the path to the config defaults file
 */
export declare function getConfigDefaultsPath(): string;
/**
 * Get the path to the initialization semaphore file
 */
export declare function getInitSemaphorePath(): string;
/**
 * Check if config file exists
 */
export declare function configExists(): boolean;
/**
 * Check if the system has been initialized
 */
export declare function isInitialized(): boolean;
/**
 * Write initialization semaphore file with version information
 */
export declare function writeInitSemaphore(version: string): void;
/**
 * Read initialization information from semaphore file
 */
export declare function readInitSemaphore(): {
    version: string;
    initializedAt: string;
} | null;
/**
 * Load configuration from file
 */
export declare function loadConfig(): WorklogConfig | null;
/**
 * Load configuration without enforcing status/stage sections.
 * Useful for CLI paths that only need core fields like prefix.
 */
export declare function loadConfigRelaxed(): WorklogConfig | null;
/**
 * Save configuration to file
 */
export declare function saveConfig(config: WorklogConfig): void;
/**
 * Get the default prefix (WI if no config exists)
 */
export declare function getDefaultPrefix(): string;
export type InitConfigOptions = {
    projectName?: string;
    prefix?: string;
    autoSync?: boolean;
};
/**
 * Interactive initialization of config
 */
export declare function initConfig(existingConfig?: WorklogConfig | null, options?: InitConfigOptions): Promise<WorklogConfig>;
//# sourceMappingURL=config.d.ts.map