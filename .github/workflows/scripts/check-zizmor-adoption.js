// @ts-check
const fs = require('node:fs')

const ZIZMOR_ACTION = 'zizmorcore/zizmor-action'

/** @typedef {import('@actions/github-script').AsyncFunctionArguments['github']} GitHub */
/** @typedef {import('@octokit/plugin-rest-endpoint-methods').RestEndpointMethodTypes['repos']['listForOrg']['response']['data'][number]} OrgRepo */

/**
 * A repo is "covered" when it has no workflows to audit, or when any workflow
 * file references `zizmorcore/zizmor-action`. Repos without any workflow don't
 * need the zizmor action, so they are not reported.
 *
 * @param {GitHub} github
 * @param {OrgRepo} repo
 * @param {string} ref commit SHA to read every file from
 */
async function isZizmorCovered(github, repo, ref) {
  const owner = repo.owner.login
  let entries
  try {
    const res = await github.rest.repos.getContent({
      owner,
      repo: repo.name,
      path: '.github/workflows',
      ref,
    })
    entries = Array.isArray(res.data) ? res.data : []
  } catch (error) {
    const err = /** @type {import('@octokit/request-error').RequestError} */ (error)
    // 404 means the repository has no `.github/workflows` directory, so there
    // is nothing for zizmor to audit.
    if (err.status === 404) {
      return true
    }
    throw err
  }

  const workflowFiles = entries.filter(
    (entry) => entry.type === 'file' && /\.ya?ml$/.test(entry.name),
  )
  // No workflow files means nothing for zizmor to audit.
  if (workflowFiles.length === 0) {
    return true
  }
  for (const file of workflowFiles) {
    const res = await github.rest.repos.getContent({
      owner,
      repo: repo.name,
      path: file.path,
      ref,
      mediaType: { format: 'raw' },
    })
    // The `raw` media type returns the file content directly as a string
    // (`String` keeps the types happy without changing the runtime value).
    if (String(res.data).includes(ZIZMOR_ACTION)) return true
  }
  return false
}

/**
 * Resolves a repository's default branch to a commit SHA, so the content reads
 * and the reported URL all point at the exact same commit.
 *
 * @param {GitHub} github
 * @param {OrgRepo} repo
 * @returns {Promise<string | null>} `null` for an empty repository (no commits)
 */
async function resolveDefaultBranchSha(github, repo) {
  try {
    const branch = await github.rest.repos.getBranch({
      owner: repo.owner.login,
      repo: repo.name,
      branch: /** @type {string} */ (repo.default_branch),
    })
    return branch.data.commit.sha
  } catch (error) {
    const err = /** @type {import('@octokit/request-error').RequestError} */ (error)
    // An empty repository has no commits, so there is nothing to audit.
    if (err.status === 404) return null
    throw err
  }
}

/**
 * Finds public repositories in the organization that do not reference
 * `zizmorcore/zizmor-action` in any workflow and writes a SARIF report
 * (`zizmor-adoption.sarif`) with one result per uncovered repository.
 *
 * @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments
 */
module.exports = async ({ github, context, core }) => {
  const org = context.repo.owner

  const repos = (
    await github.paginate(github.rest.repos.listForOrg, {
      org,
      type: 'public',
      per_page: 100,
    })
  ).filter(
    (repo) => !repo.archived && !repo.fork,
  )

  core.info(`Checking ${repos.length} public repositories in ${org}`)

  const missing = []
  for (const repo of repos) {
    const ref = await resolveDefaultBranchSha(github, repo)
    // An empty repository has nothing to audit.
    if (ref === null) continue

    if (!(await isZizmorCovered(github, repo, ref))) {
      core.info(`  missing zizmor: ${repo.full_name}`)
      missing.push({ repo, ref })
    }
  }

  core.info(`${missing.length} repositories do not use ${ZIZMOR_ACTION}`)

  /** @type {import('sarif').Log} */
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'zizmor-adoption-check',
            informationUri: 'https://github.com/vitejs/.github/tree/main/.github/workflows/check-zizmor-adoption.yml',
            rules: [
              {
                id: 'missing-zizmor-action',
                name: 'MissingZizmorAction',
                shortDescription: {
                  text: 'Repository does not use zizmorcore/zizmor-action',
                },
                fullDescription: {
                  text: 'No workflow in this repository references zizmorcore/zizmor-action, so its GitHub Actions workflows are not audited by zizmor.',
                },
                helpUri: 'https://github.com/vitejs/.github/tree/main/.github/workflows/check-zizmor-adoption.yml',
                defaultConfiguration: { level: 'warning' },
              },
            ],
          },
        },
        results: missing.map(({ repo, ref }) => /** @satisfies {import('sarif').Result} */ ({
          ruleId: 'missing-zizmor-action',
          level: 'warning',
          message: {
            text: `${repo.full_name} does not use ${ZIZMOR_ACTION} in any workflow. Add the zizmor action to audit its GitHub Actions workflows.`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: `${repo.html_url}/tree/${ref}/.github/workflows`,
                },
                region: { startLine: 1 },
              },
            },
          ],
          partialFingerprints: {
            repository: repo.full_name,
          },
        })),
      },
    ],
  }

  fs.writeFileSync('zizmor-adoption.sarif', JSON.stringify(sarif))
  core.info('Wrote zizmor-adoption.sarif')
}
