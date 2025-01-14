import { NxJsonConfiguration, readNxJson } from '../../config/nx-json';
import {
  ProjectGraph,
  ProjectGraphProjectNode,
} from '../../config/project-graph';
import { output } from '../../devkit-exports';
import { createProjectGraphAsync } from '../../project-graph/project-graph';
import { runCommand } from '../../tasks-runner/run-command';
import {
  createOverrides,
  readGraphFileFromGraphArg,
} from '../../utils/command-line-utils';
import { handleErrors } from '../../utils/params';
import { projectHasTarget } from '../../utils/project-graph-utils';
import { generateGraph } from '../graph/graph';
import { PublishOptions } from './command-object';
import {
  createNxReleaseConfig,
  handleNxReleaseConfigError,
} from './config/config';
import { filterReleaseGroups } from './config/filter-release-groups';

export const releasePublishCLIHandler = (args: PublishOptions) =>
  handleErrors(args.verbose, () => releasePublish(args, true));

/**
 * NOTE: This function is also exported for programmatic usage and forms part of the public API
 * of Nx. We intentionally do not wrap the implementation with handleErrors because users need
 * to have control over their own error handling when using the API.
 */
export async function releasePublish(
  args: PublishOptions,
  isCLI = false
): Promise<number> {
  /**
   * When used via the CLI, the args object will contain a __overrides_unparsed__ property that is
   * important for invoking the relevant executor behind the scenes.
   *
   * We intentionally do not include that in the function signature, however, so as not to cause
   * confusing errors for programmatic consumers of this function.
   */
  const _args = args as PublishOptions & { __overrides_unparsed__: string[] };

  const projectGraph = await createProjectGraphAsync({ exitOnError: true });
  const nxJson = readNxJson();

  if (_args.verbose) {
    process.env.NX_VERBOSE_LOGGING = 'true';
  }

  // Apply default configuration to any optional user configuration
  const { error: configError, nxReleaseConfig } = await createNxReleaseConfig(
    projectGraph,
    nxJson.release
  );
  if (configError) {
    return await handleNxReleaseConfigError(configError);
  }

  const {
    error: filterError,
    releaseGroups,
    releaseGroupToFilteredProjects,
  } = filterReleaseGroups(
    projectGraph,
    nxReleaseConfig,
    _args.projects,
    _args.groups
  );
  if (filterError) {
    output.error(filterError);
    process.exit(1);
  }

  /**
   * If the user is filtering to a subset of projects or groups, we should not run the publish task
   * for dependencies, because that could cause projects outset of the filtered set to be published.
   */
  const shouldExcludeTaskDependencies =
    _args.projects?.length > 0 || _args.groups?.length > 0;

  let overallExitStatus = 0;

  if (args.projects?.length) {
    /**
     * Run publishing for all remaining release groups and filtered projects within them
     */
    for (const releaseGroup of releaseGroups) {
      const status = await runPublishOnProjects(
        _args,
        projectGraph,
        nxJson,
        Array.from(releaseGroupToFilteredProjects.get(releaseGroup)),
        shouldExcludeTaskDependencies,
        isCLI
      );
      if (status !== 0) {
        overallExitStatus = status || 1;
      }
    }

    return overallExitStatus;
  }

  /**
   * Run publishing for all remaining release groups
   */
  for (const releaseGroup of releaseGroups) {
    const status = await runPublishOnProjects(
      _args,
      projectGraph,
      nxJson,
      releaseGroup.projects,
      shouldExcludeTaskDependencies,
      isCLI
    );
    if (status !== 0) {
      overallExitStatus = status || 1;
    }
  }

  return overallExitStatus;
}

async function runPublishOnProjects(
  args: PublishOptions & { __overrides_unparsed__: string[] },
  projectGraph: ProjectGraph,
  nxJson: NxJsonConfiguration,
  projectNames: string[],
  shouldExcludeTaskDependencies: boolean,
  isCLI: boolean
): Promise<number> {
  const projectsToRun: ProjectGraphProjectNode[] = projectNames.map(
    (projectName) => projectGraph.nodes[projectName]
  );

  const overrides = createOverrides(args.__overrides_unparsed__);

  if (args.registry) {
    overrides.registry = args.registry;
  }
  if (args.tag) {
    overrides.tag = args.tag;
  }
  if (args.otp) {
    overrides.otp = args.otp;
  }
  if (args.dryRun) {
    overrides.dryRun = args.dryRun;
    /**
     * Ensure the env var is set too, so that any and all publish executors triggered
     * indirectly via dependsOn can also pick up on the fact that this is a dry run.
     */
    process.env.NX_DRY_RUN = 'true';
  }

  if (args.verbose) {
    process.env.NX_VERBOSE_LOGGING = 'true';
  }

  if (args.firstRelease) {
    overrides.firstRelease = args.firstRelease;
  }

  const targets = ['nx-release-publish'];

  if (args.graph) {
    const file = readGraphFileFromGraphArg(args);
    const projectNames = projectsToRun.map((t) => t.name);
    await generateGraph(
      {
        watch: false,
        all: false,
        open: true,
        view: 'tasks',
        targets,
        projects: projectNames,
        file,
      },
      projectNames
    );
    return 0;
  }

  const requiredTargetName = 'nx-release-publish';
  const projectsWithTarget = projectsToRun.filter((project) =>
    projectHasTarget(project, requiredTargetName)
  );

  if (projectsWithTarget.length === 0) {
    throw new Error(
      `Based on your config, the following projects were matched for publishing but do not have the "${requiredTargetName}" target specified:\n${[
        ...projectsToRun.map((p) => `- ${p.name}`),
        '',
        `This is usually caused by not having an appropriate plugin, such as "@nx/js" installed, which will add the appropriate "${requiredTargetName}" target for you automatically.`,
      ].join('\n')}\n`
    );
  }

  /**
   * Run the relevant nx-release-publish executor on each of the selected projects.
   */
  const status = await runCommand(
    projectsWithTarget,
    projectGraph,
    { nxJson },
    {
      targets,
      outputStyle: 'static',
      ...(args as any),
    },
    overrides,
    null,
    {},
    {
      excludeTaskDependencies: shouldExcludeTaskDependencies,
      loadDotEnvFiles: true,
    }
  );

  if (status !== 0) {
    // In order to not add noise to the overall CLI output, do not throw an additional error
    if (isCLI) {
      return status;
    }
    // Throw an additional error for programmatic API usage
    throw new Error(
      'One or more of the selected projects could not be published'
    );
  }

  return 0;
}
