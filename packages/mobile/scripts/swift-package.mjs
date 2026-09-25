/** Normalize Capacitor's generated manifest against the verified native build. */
export function normalizeSwiftPackage(source, capacitorVersion, minimumOS) {
  if (typeof capacitorVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(capacitorVersion)) {
    throw new Error('@capacitor/ios must use an exact release version in package.json.');
  }
  if (typeof minimumOS !== 'string' || !/^\d+\.\d+$/.test(minimumOS)) {
    throw new Error('The iOS native build manifest must declare its minimum OS.');
  }
  // Capacitor can parse $(RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET) as a literal
  // version and generate invalid Swift (.v"$). Keep the native build's floor.
  const platform = /^\s*platforms:.*,$/gm;
  if ([...source.matchAll(platform)].length !== 1) {
    throw new Error('Expected one generated Swift package platforms declaration.');
  }
  const dependency =
    /\.package\(\s*url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git"\s*,\s*(?:from|exact):\s*"[^"\r\n]+"\s*\)/g;
  if ([...source.matchAll(dependency)].length !== 1) {
    throw new Error('Expected one Capacitor Swift package declaration after cap sync.');
  }
  return source
    .replace(platform, () => `    platforms: [.iOS("${minimumOS}")],`)
    .replace(
      dependency,
      `.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "${capacitorVersion}")`,
    );
}
