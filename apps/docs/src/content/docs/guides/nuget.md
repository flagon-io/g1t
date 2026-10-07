---
title: NuGet
description: Push and restore a workspace's .NET packages with dotnet, from a NuGet feed of its own on g1t.sh, from your machine and from workflows.
---

Every workspace has a NuGet feed of its own, speaking the NuGet v3
protocol that `dotnet`, Visual Studio, Rider and `nuget.exe` read. `dotnet
nuget push` publishes to it, and restores install from it, private
packages included.

```text
https://g1t.sh/-/nuget/<workspace>/v3/index.json
```

Packages from nuget.org still come from nuget.org; only the packages you
push here come from g1t.

## Add the feed

Add the feed as a package source, named for the workspace. For a feed with
private packages, give it a username (any works) and an
[access token](https://g1t.sh/settings/tokens) as the password:

```sh
dotnet nuget add source https://g1t.sh/-/nuget/acme/v3/index.json --name acme \
  --username ada --password <token> --store-password-in-clear-text
```

That writes the source into your user `NuGet.Config`. To keep it with the
project instead, put a `nuget.config` beside the solution, with the token
read from the environment:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="acme" value="https://g1t.sh/-/nuget/acme/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <acme>
      <add key="Username" value="ada" />
      <add key="ClearTextPassword" value="%G1T_TOKEN%" />
    </acme>
  </packageSourceCredentials>
</configuration>
```

A token with full access works; one with scopes needs `packages:read` to
restore private packages and `packages:write` to push and unlist. A feed
whose packages are all public restores without credentials.

## Push

Say in the project file what the package is and which repository it comes
from:

```xml
<PropertyGroup>
  <PackageId>Acme.Http</PackageId>
  <Version>0.3.1</Version>
  <Description>Our HTTP client</Description>
  <RepositoryUrl>https://g1t.sh/acme/http</RepositoryUrl>
  <PackageReadmeFile>README.md</PackageReadmeFile>
</PropertyGroup>
<ItemGroup>
  <None Include="README.md" Pack="true" PackagePath="\" />
</ItemGroup>
```

```sh
dotnet pack -c Release
dotnet nuget push bin/Release/Acme.Http.0.3.1.nupkg --source acme --api-key <token>
```

The token is the API key. The first push makes the package. When its
`RepositoryUrl` is a g1t.sh repository of the same workspace, or a
repository is named like its id in lowercase (`acme.http`, or `acme-http`),
it is linked to that repository and has its visibility and roles: pushing
needs Write on it. Otherwise it is the workspace's, private, and needs the
workspace's Write base permission. See
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package).

The package's page on g1t.sh shows the README the package names
(`PackageReadmeFile`) and the description of its highest stable version,
and each version's downloads: every `.nupkg` restored counts for its
version, and the registration (`downloads` in each catalog entry) and
search (each version's `downloads`, and the package's `totalDownloads`)
say them too. Counts are approximate.

## Symbols

Push a symbol package beside the package, and debuggers can step into
its code: the feed has a symbol server that serves each PDB by the key
the debugger asks for. Build a `.snupkg` with the package:

```xml
<PropertyGroup>
  <IncludeSymbols>true</IncludeSymbols>
  <SymbolPackageFormat>snupkg</SymbolPackageFormat>
</PropertyGroup>
```

`dotnet pack` then writes `Acme.Http.0.3.1.snupkg` beside the `.nupkg`,
and `dotnet nuget push` of the `.nupkg` pushes it after the package, to
the feed's `SymbolPackagePublish` resource, with the same API key. A
symbol package is for a version already pushed; its PDBs must be portable
PDBs (`DebugType` `portable`, the default). A version's symbols are pushed
once. Its page marks the versions that have them, and the `.snupkg` is in
the flat container beside the `.nupkg`.

The symbol server is at:

```text
https://g1t.sh/-/nuget/<workspace>/symbols/
```

Add that address as a symbol server in your debugger (in Visual Studio,
**Tools > Options > Debugging > Symbols**). It answers the Simple Symbol
Query Protocol, `symbols/<file>.pdb/<key>/<file>.pdb`, for the
packages the credentials' owner may see; debuggers that send no
credentials to a symbol server load the symbols of public packages.
`dotnet-symbol` sends a token with `--authenticated-server-path`:

```sh
dotnet-symbol --authenticated-server-path <token> https://g1t.sh/-/nuget/acme/symbols/   -o symbols bin/Debug/net8.0/Acme.Http.dll
```

## Restore

```sh
dotnet add package Acme.Http --source https://g1t.sh/-/nuget/acme/v3/index.json
```

`dotnet add package` takes the feed's address here, not the source's
name; the credentials still come from the source of that address. After
that, `dotnet restore` and `dotnet build` find the package through the
source. If your `nuget.config` uses
[package source mapping](https://learn.microsoft.com/nuget/consume-packages/package-source-mapping),
map the workspace's packages to the feed:

```xml
<packageSourceMapping>
  <packageSource key="nuget.org"><package pattern="*" /></packageSource>
  <packageSource key="acme"><package pattern="Acme.*" /></packageSource>
</packageSourceMapping>
```

`dotnet package search Acme --source acme` lists the workspace's packages
you can see whose ids or descriptions match.

## Ids and versions

An id is letters, digits and `_`, in parts joined by `.` or `-`, at most
100 characters. Ids are one whatever their case: once `Acme.Http` is
pushed, `acme.http` is the same package.

Versions are read as NuGet reads them: `1.0` is `1.0.0`, and build metadata
(`+abc`) is not part of the version. A version is pushed once: pushing
one that is already there, listed or not, is refused with `409`, so bump
`Version` first.

## Unlist

```sh
dotnet nuget delete Acme.Http 0.3.1 --source acme --api-key <token> --non-interactive
```

As on nuget.org, this unlists the version rather than deleting it:
projects that name it still restore it, but search no longer shows it, and
its registration says `"listed": false`. Unlisting needs
what pushing does. The package's page marks unlisted versions, and someone
with Admin on the linked repository (an owner, for the workspace's own
packages) can delete a version there for good.

## Private and public packages

A package linked to a repository has the repository's visibility; one of
the workspace's own is private until an owner makes it public on its page.

| The workspace's packages | Without credentials | With credentials |
| --- | --- | --- |
| All public | `dotnet` reads the feed and restores them. | The same; the API key is sent to push. |
| Some private | The feed answers `401`, which makes `dotnet` send the source's credentials. | Each package the credentials' owner may see. |

A private package you cannot see looks exactly like one that does not
exist.

## In workflows

A workflow's `G1T_TOKEN` is the workspace's own token for the run, and can
restore and push the workspace's packages. With the `nuget.config` above,
which reads `%G1T_TOKEN%`:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: dotnet test
      - run: dotnet pack -c Release -o out
      - run: dotnet nuget push "out/*.nupkg" --source acme --api-key "$G1T_TOKEN"
```

## Size

A push is one request with the `.nupkg` inside it, and may hold at most
100 MB. Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), a
workspace's private packages may hold 500 MB and its public ones 10 GB, as
for [container images](/guides/containers/#storage-and-pull-limits). A
`.nupkg` is stored once, by its content.

## Errors

| Error | Means |
| --- | --- |
| `401` | No credentials or API key, or a wrong or expired token. Check the source's username and password, or the `--api-key`. |
| `403` | Signed in, but your role or your token's scopes do not allow it, or the workspace is out of free package storage. The response says which. |
| `404` | No such package or version, or a private one you cannot see. For a symbol package: its version is not pushed yet. |
| `409` | That version is already pushed, or already has symbols. Bump `Version`. |
| `400` | The push was refused: not a `.nupkg`, no `.nuspec` in it, an id or version NuGet would not take, or a symbol package that is not one or holds a PDB that is not portable. The response says which. |
| `413` | The `.nupkg` is over 100 MB. |
