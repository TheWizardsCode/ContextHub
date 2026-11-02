/**
 * Dependency commands - Manage dependency edges
 *
 * A dependency target may live in a **discovered sibling project's** store
 * (parent WL-0MVWABT2Z001XMSD, D2): `add` / `rm` / `list` resolve such an id
 * read-only through `src/cross-repo/foreign-store.ts` and record the edge in
 * the local store. Same-project behaviour is untouched.
 */

import chalk from 'chalk';
import type { PluginContext } from '../plugin-types.js';
import type { DepOptions } from '../cli-types.js';
import { normalizeActionArgs } from './cli-utils.js';
import { classifyWorkItemId } from '../cli-utils.js';
import { resolveForeignItem, type ForeignItemResolution } from '../cross-repo/foreign-store.js';
import { withStoreMutationLock } from '../mutation-lock.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  /**
   * Refuse an ambiguous foreign prefix: two discovered projects declare it, so
   * no single store owns the endpoint. Both candidate paths are reported and
   * the edge is never recorded against a guessed owner (D1/D2).
   */
  const refuseAmbiguousForeignPrefix = (resolution: ForeignItemResolution): void => {
    const candidates = resolution.candidates ?? [];
    const message =
      `Ambiguous project prefix '${resolution.prefix}': declared by ${candidates.length} ` +
      'projects, so the foreign endpoint cannot be resolved to a single store. ' +
      'Refusing to guess an owner.';
    if (utils.isJsonMode()) {
      output.json({
        success: false,
        error: message,
        error_code: 'ambiguous_prefix',
        prefix: resolution.prefix,
        projects_root: resolution.projectsRoot,
        candidates,
        errors: candidates.map((candidate) => `Candidate project: ${candidate}`),
      });
    } else {
      console.error(chalk.red(`Error: ${message}`));
      candidates.forEach((candidate) => console.error(`  - ${candidate}`));
    }
    process.exitCode = 1;
  };

  const depCommand = program
    .command('dep')
    .description(
      'Manage dependency edges (foreign cross-project ids from discovered sibling projects are supported)',
    );

  depCommand
    .command('add <itemId> <dependsOnId>')
    .description(
      'Add a dependency edge (item depends on dependsOn); dependsOn may be a foreign cross-project id',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((itemId: string, dependsOnId: string, ...rawArgs: any[]) =>
      withStoreMutationLock(ctx.dataPath, () => {
      const normalized = normalizeActionArgs(rawArgs, ['prefix']);
      let options: DepOptions = normalized.options as any || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const normalizedDependsOnId = utils.normalizeCliId(dependsOnId, options.prefix) || dependsOnId;
      const itemIdLookup = normalizedItemId.toUpperCase();
      const dependsOnIdLookup = normalizedDependsOnId.toUpperCase();

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      let dependsOn = db.get(dependsOnIdLookup);
      let foreignTarget: ForeignItemResolution | undefined;

      // A target that is not local may live in a discovered sibling project's
      // store (D2). Its existence is validated there, read-only.
      if (!dependsOn) {
        const classification = classifyWorkItemId(db, dependsOnIdLookup);
        if (classification.origin === 'foreign') {
          foreignTarget = classification.foreign;
          if (foreignTarget?.ambiguous) {
            refuseAmbiguousForeignPrefix(foreignTarget);
            return;
          }
          if (foreignTarget?.state === 'resolved') {
            dependsOn = foreignTarget.item ?? null;
          }
        }
      }

      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);
      if (!dependsOn) warnings.push(`Work item not found: ${normalizedDependsOnId}`);

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.error('One or more work items were not found', { success: false, errors: warnings });
        } else {
          warnings.forEach(w => console.error(chalk.red(`Error: ${w}`)));
        }
        process.exit(1);
      }

      const existing = db.listDependencyEdgesFrom(itemIdLookup).some(edge => edge.toId === dependsOnIdLookup);
      if (existing) {
        if (utils.isJsonMode()) {
          output.error('Dependency already exists.', { success: false, error: 'Dependency already exists.' });
        } else {
          console.error('Dependency already exists.');
        }
        process.exit(1);
      }

      const edge = db.addDependencyEdge(itemIdLookup, dependsOnIdLookup, {
        allowForeignTarget: foreignTarget !== undefined,
      });
      if (dependsOn && !['in_review', 'done'].includes(dependsOn.stage)) {
        if (item && !['completed', 'deleted'].includes(item.status)) {
          // The caller decided the status from the target's own (possibly
          // foreign) record, so the derived blocked/open reconciliation must
          // not override it.
          db.update(itemIdLookup, { status: 'blocked' }, { reconcileSelf: false });
        }
      }
      if (utils.isJsonMode()) {
        output.json({ success: true, edge });
      } else {
        console.log(chalk.green('Successfully added dependency between'));
        const itemLabel = `${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`;
        const dependsOnLabel = `${dependsOn?.title || dependsOnIdLookup} ${chalk.gray(`(${dependsOnIdLookup})`)}`;
        console.log(`${itemLabel} ${chalk.green('which depends on')}`);
        console.log(`${dependsOnLabel}.`);
      }
      }),
    );

  depCommand
    .command('rm <itemId> <dependsOnId>')
    .description(
      'Remove a dependency edge (item depends on dependsOn); dependsOn may be a foreign cross-project id',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((itemId: string, dependsOnId: string, ...rawArgs: any[]) =>
      withStoreMutationLock(ctx.dataPath, () => {
      const normalized = normalizeActionArgs(rawArgs, ['prefix']);
      let options: DepOptions = normalized.options as any || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const normalizedDependsOnId = utils.normalizeCliId(dependsOnId, options.prefix) || dependsOnId;
      const itemIdLookup = normalizedItemId.toUpperCase();
      const dependsOnIdLookup = normalizedDependsOnId.toUpperCase();

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      const dependsOn = db.get(dependsOnIdLookup);
      const edgeExists = db
        .listDependencyEdgesFrom(itemIdLookup)
        .some(edge => edge.toId === dependsOnIdLookup);
      // Removing a foreign edge needs no existence proof from the sibling
      // store (the edge is local data); its record is read read-only purely to
      // label the human output.
      const foreignTarget =
        !dependsOn && edgeExists ? resolveForeignItem(dependsOnIdLookup) : undefined;

      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);
      if (!dependsOn && !edgeExists) {
        warnings.push(`Work item not found: ${normalizedDependsOnId}`);
      }

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, warnings, removed: false, edge: null });
        } else {
          warnings.forEach(w => console.warn(`Warning: ${w}`));
        }
        return;
      }

      const removed = db.removeDependencyEdge(itemIdLookup, dependsOnIdLookup);
      if (removed) {
        db.reconcileDependentStatus(itemIdLookup);
      }
      if (utils.isJsonMode()) {
        output.json({ success: true, removed, edge: { fromId: itemIdLookup, toId: dependsOnIdLookup } });
      } else if (removed) {
        console.log(chalk.green('Successfully removed dependency between'));
        const itemLabel = `${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`;
        const dependsOnLabel = `${dependsOn?.title || foreignTarget?.item?.title || dependsOnIdLookup} ${chalk.gray(`(${dependsOnIdLookup})`)}`;
        console.log(`${itemLabel} ${chalk.green('no longer depends on')}`);
        console.log(`${dependsOnLabel}.`);
      } else {
        console.log(`No dependency found: ${itemIdLookup} depends on ${dependsOnIdLookup}`);
      }

      if (removed && item && !['completed', 'deleted'].includes(item.status)) {
        db.reconcileDependentStatus(itemIdLookup);
      }
      }),
    );

  depCommand
    .command('list <itemId>')
    .description(
      'List inbound and outbound dependency edges for a work item (foreign cross-project targets included)',
    )
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--outgoing', 'Only show outbound dependencies')
    .option('--incoming', 'Only show inbound dependencies')
    .action((itemId: string, ...rawArgs: any[]) => {
      const normalized = normalizeActionArgs(rawArgs, ['prefix','outgoing','incoming']);
      let options: DepOptions = normalized.options as any || {};
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const itemIdLookup = normalizedItemId.toUpperCase();

      if (options.incoming && options.outgoing) {
        const message = 'Cannot use --incoming and --outgoing together.';
        if (utils.isJsonMode()) {
          output.error(message, { success: false, error: message });
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
      }

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, warnings, inbound: [], outbound: [] });
        } else {
          warnings.forEach(w => console.warn(`Warning: ${w}`));
        }
        return;
      }

      const outboundEdges = options.incoming ? [] : db.listDependencyEdgesFrom(itemIdLookup);
      const inboundEdges = options.outgoing ? [] : db.listDependencyEdgesTo(itemIdLookup);

      const outbound = outboundEdges.map(edge => {
        const dep = db.get(edge.toId);
        if (dep) {
          return {
            id: edge.toId,
            title: dep.title || '(missing)',
            status: dep.status || 'deleted',
            priority: dep.priority || 'medium',
            direction: 'depends-on',
          };
        }
        // Not in the local store: resolve it read-only against the discovered
        // sibling project and carry the tri-state outcome (D2/D3).
        const foreign = resolveForeignItem(edge.toId);
        const foreignItem = foreign.state === 'resolved' ? foreign.item : undefined;
        return {
          id: edge.toId,
          title: foreignItem?.title || '(missing)',
          status: foreignItem?.status || 'deleted',
          stage: foreignItem?.stage || '',
          priority: foreignItem?.priority || 'medium',
          direction: 'depends-on',
          foreign: true,
          foreign_dependency: foreign.state,
        };
      });

      const inbound = inboundEdges.map(edge => {
        const dep = db.get(edge.fromId);
        return {
          id: edge.fromId,
          title: dep?.title || '(missing)',
          status: dep?.status || 'deleted',
          priority: dep?.priority || 'medium',
          direction: 'depended-on-by',
        };
      });

      if (utils.isJsonMode()) {
        output.json({ success: true, item: itemIdLookup, inbound, outbound });
        return;
      }

      console.log(`Dependencies for ${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`);
      console.log('');
      if (!options.incoming) {
        console.log('Depends on:');
      }
      if (outbound.length === 0) {
        if (!options.incoming) {
          console.log('  (none)');
        }
      } else {
        outbound.forEach(dep => {
          const titleText = dep.status === 'completed'
            ? chalk.green(chalk.strikethrough(dep.title))
            : chalk.red(dep.title);
          console.log(`  - ${titleText} ${chalk.gray(`(${dep.id})`)} Status: ${dep.status} Priority: ${dep.priority} Direction: ${dep.direction}`);
        });
      }
      if (!options.incoming && !options.outgoing) {
        console.log('');
      }
      if (!options.outgoing) {
        console.log('Depended on by:');
      }
      if (inbound.length === 0) {
        if (!options.outgoing) {
          console.log('  (none)');
        }
      } else {
        inbound.forEach(dep => {
          console.log(`  - ${dep.title} ${chalk.gray(`(${dep.id})`)} Status: ${dep.status} Priority: ${dep.priority} Direction: ${dep.direction}`);
        });
      }
    });
}
