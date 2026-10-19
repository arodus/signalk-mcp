const path = require("node:path");
const { container } = require("webpack");

module.exports = {
  mode: "production",
  entry: {},
  output: {
    path: path.resolve(__dirname, "public"),
    filename: "[name].[contenthash].js",
    publicPath: "auto",
    uniqueName: "signalk_mcp",
    clean: true,
  },
  plugins: [
    new container.ModuleFederationPlugin({
      name: "signalk_mcp",
      library: { type: "var", name: "signalk_mcp" },
      filename: "remoteEntry.js",
      exposes: { "./PluginConfigurationPanel": "./ui/panel.mjs" },
      // The native Admin UI owns React; never ship a second hook dispatcher.
      shared: {
        react: { singleton: true, requiredVersion: "^19", import: false },
      },
    }),
  ],
};
