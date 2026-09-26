import type { OfficeApp } from '@bendyline/gezel';

/**
 * The XML "add-in only" manifest Word, Excel and PowerPoint accept from a
 * per-user registration (Windows `HKCU\...\WEF\Developer`, macOS
 * `~/Library/Containers/com.microsoft.<App>/Data/Documents/wef/`).
 *
 * Element order is significant: the Office schema is an XSD sequence.
 * Requirement sets are the minimum for the pane to load; each document tool
 * checks the finer set it needs at runtime, so an older Office still gets
 * the chat.
 */

const HOSTS: Record<OfficeApp, { hostName: string; requirementSet: string }> = {
  word: { hostName: 'Document', requirementSet: 'WordApi' },
  excel: { hostName: 'Workbook', requirementSet: 'ExcelApi' },
  powerpoint: { hostName: 'Presentation', requirementSet: 'PowerPointApi' },
};

export const OFFICE_ICON_SIZES = [16, 32, 64, 80] as const;
export const OFFICE_SUPPORT_URL = 'https://github.com/bendyline/gezel';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Office requires `n[.n[.n[.n]]]`, each part at most five digits. `1.26244.61` → `1.26244.61.0`. */
export function officeVersionString(version: string): string {
  const parts = (version.split(/[-+]/)[0] ?? '')
    .split('.')
    .map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p))
    .slice(0, 4)
    .map((p) => String(Math.min(Number.parseInt(p, 10), 99_999)));
  while (parts.length < 4) parts.push('0');
  return parts.join('.');
}

export function officeTaskpanePath(app: OfficeApp): string {
  return `/office/${app}/taskpane.html`;
}

export interface OfficeManifestInput {
  app: OfficeApp;
  /** `https://localhost:<port>` */
  origin: string;
  /** Add-in GUID, stable per gezel home. */
  id: string;
  version: string;
  displayName?: string;
}

export function buildOfficeManifest(input: OfficeManifestInput): string {
  const { hostName, requirementSet } = HOSTS[input.app];
  const origin = input.origin.replace(/\/+$/, '');
  const url = (path: string) => escapeXml(`${origin}${path}`);
  const name = escapeXml(input.displayName ?? 'Gezel');
  const icon = (size: number) => url(`/office/icons/icon-${size}.png`);
  const iconSet = (indent: string) =>
    [16, 32, 80]
      .map((size) => `${indent}<bt:Image size="${size}" resid="Gezel.Icon.${size}"/>`)
      .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>${escapeXml(input.id)}</Id>
  <Version>${officeVersionString(input.version)}</Version>
  <ProviderName>Bendyline</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${name}"/>
  <Description DefaultValue="Work with your gezels on this document."/>
  <IconUrl DefaultValue="${icon(32)}"/>
  <HighResolutionIconUrl DefaultValue="${icon(64)}"/>
  <SupportUrl DefaultValue="${escapeXml(OFFICE_SUPPORT_URL)}"/>
  <Hosts>
    <Host Name="${hostName}"/>
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="${requirementSet}" MinVersion="1.1"/>
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue="${url(officeTaskpanePath(input.app))}"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="${hostName}">
        <DesktopFormFactor>
          <FunctionFile resid="Gezel.Commands.Url"/>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Gezel.Group">
                <Label resid="Gezel.Group.Label"/>
                <Icon>
${iconSet('                  ')}
                </Icon>
                <Control xsi:type="Button" id="Gezel.OpenPane">
                  <Label resid="Gezel.Button.Label"/>
                  <Supertip>
                    <Title resid="Gezel.Button.Label"/>
                    <Description resid="Gezel.Button.Tooltip"/>
                  </Supertip>
                  <Icon>
${iconSet('                    ')}
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>Gezel.Pane</TaskpaneId>
                    <SourceLocation resid="Gezel.Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
${[16, 32, 80].map((size) => `        <bt:Image id="Gezel.Icon.${size}" DefaultValue="${icon(size)}"/>`).join('\n')}
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Gezel.Commands.Url" DefaultValue="${url('/office/commands.html')}"/>
        <bt:Url id="Gezel.Taskpane.Url" DefaultValue="${url(officeTaskpanePath(input.app))}"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Gezel.Group.Label" DefaultValue="${name}"/>
        <bt:String id="Gezel.Button.Label" DefaultValue="${name}"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Gezel.Button.Tooltip" DefaultValue="Open Gezel to work with your gezels on this document."/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
}
