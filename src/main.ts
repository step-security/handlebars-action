import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { Config, Data, DataWithOutputFile } from './types.d';
import { buildBaseData, buildFileData, buildTemplate } from './utils';
import fs from 'fs';
import path from 'path';
import axios, { isAxiosError } from 'axios';

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'pedrolamas/handlebars-action';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(`https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`, body, { timeout: 3000 });
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

export const run = async (): Promise<void> => {
  try {
    await validateSubscription();
    const config: Config = {
      files: core.getInput('files'),
      outputFilename: core.getInput('output-filename'),
      deleteInputFile: core.getInput('delete-input-file') === 'true',
      htmlEscape: core.getInput('html-escape') === 'true',
      dryRun: core.getInput('dry-run') === 'true',
    };

    core.debug(`Configuration:\n${JSON.stringify(config, undefined, 2)}`);

    const baseData = buildBaseData();

    core.debug(`Base data:\n${JSON.stringify(baseData, undefined, 2)}`);

    const outputFilenameTemplate = buildTemplate(config.outputFilename, { noEscape: true });

    const globber = await glob.create(config.files);

    for await (const inputFilename of globber.globGenerator()) {
      const fileStats = await fs.promises.stat(inputFilename);

      if (!fileStats.isFile()) {
        continue;
      }

      const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

      if (!path.resolve(inputFilename).startsWith(path.resolve(workspace) + path.sep)) {
        throw new Error(`Input filename "${inputFilename}" resolves outside the workspace directory`);
      }

      core.debug(`Reading input file "${inputFilename}"...`);

      const data: Data = {
        ...baseData,
        file: buildFileData(inputFilename),
      };
      const outputFilename = outputFilenameTemplate(data);

      if (!path.resolve(outputFilename).startsWith(path.resolve(workspace) + path.sep)) {
        throw new Error(`Output filename "${outputFilename}" resolves outside the workspace directory`);
      }

      const inputContent = await fs.promises.readFile(inputFilename, 'utf8');

      const outputContentTemplate = buildTemplate(inputContent, {
        noEscape: !config.htmlEscape,
      });

      const dataWithOutputFile: DataWithOutputFile = {
        ...data,
        outputFile: buildFileData(outputFilename),
      };
      const outputContent = outputContentTemplate(dataWithOutputFile);

      if (config.deleteInputFile) {
        core.debug(`Deleting input file...`);

        if (!config.dryRun) {
          await fs.promises.unlink(inputFilename);
        }
      }

      core.debug(`Writing output file "${outputFilename}"...`);

      if (!config.dryRun) {
        await fs.promises.writeFile(outputFilename, outputContent);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
};
