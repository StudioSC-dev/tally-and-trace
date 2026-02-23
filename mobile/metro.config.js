const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')

const config = getDefaultConfig(__dirname)

// ─── Monorepo support: watch root packages ─────────────────────────────────
const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

config.watchFolders = [workspaceRoot]

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Resolve @tally-trace/shared to its TypeScript source
config.resolver.extraNodeModules = {
  '@tally-trace/shared': path.resolve(workspaceRoot, 'packages/shared/src'),
}

module.exports = withNativeWind(config, { input: './global.css' })
