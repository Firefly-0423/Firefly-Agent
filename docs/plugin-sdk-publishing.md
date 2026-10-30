# Publishing the plugin SDK to npm

The SDK in `plugin-sdk/` is published as `@firefly_wu/plugin-sdk`. Releases go out from `.github/workflows/plugin-sdk-publish.yml` through npm trusted publishing (OIDC): the repository holds no npm token, and npm adds provenance automatically.

npm only lets you configure a trusted publisher for a package that already exists, so the very first version is published by hand once.

## First publish (once, by the owner)

1. Log in as the npm account `firefly_wu`, with two-factor authentication on. The package scope `@firefly_wu` is that account.
2. From a clean checkout of the commit you want to release, build and check the package:

   ```bash
   npm ci
   npm run check:plugin-sdk
   npm run test:plugin-examples
   ```

3. Log in and publish:

   ```bash
   npm login
   cd plugin-sdk
   npm publish --access public
   ```

## Connect GitHub Actions (once)

On npmjs.com, open the package → Settings → Trusted publishing → GitHub Actions, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `Firefly-0423` |
| Repository | `Firefly-Agent` |
| Workflow filename | `plugin-sdk-publish.yml` |
| Environment | leave empty |

A new trusted publisher must publish successfully within 2 days, or npm expires it. After it works, you can turn off token publishing for the package in the same settings page.

## Later releases

1. Bump `version` in `plugin-sdk/package.json` and merge the change.
2. Tag the merged commit and push the tag:

   ```bash
   git tag plugin-sdk-v0.2.1
   git push origin plugin-sdk-v0.2.1
   ```

The workflow checks that the tag matches the package version, builds and verifies the package, compiles and smoke-tests the examples, and then publishes.

Requirements met by the workflow: npm 11.5.1 or later, `id-token: write`, and `repository.url` in `plugin-sdk/package.json` matching this GitHub repository.
