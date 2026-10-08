---
title: Maven
description: Deploy and depend on a workspace's Java and Kotlin libraries with Maven or Gradle, from a Maven repository of its own on g1t.sh, SNAPSHOTs included.
---

Every workspace has a Maven repository of its own, in the standard
layout that Maven, Gradle and every other JVM build tool read. `mvn
deploy` and Gradle's `publish` upload to it, and builds resolve
dependencies from it, private ones included.

```text
https://g1t.sh/-/maven/<workspace>/
```

Dependencies from Maven Central still come from Maven Central; only the
artifacts you deploy here come from g1t.

## Credentials

Maven and Gradle send Basic credentials: any username, and an
[access token](https://g1t.sh/settings/tokens) as the password. A token
with full access works; one with scopes needs `packages:read` to resolve
private artifacts and `packages:write` to deploy. Public artifacts resolve
without one.

For Maven, put the credentials in `~/.m2/settings.xml`, as a `<server>`
whose `id` is the one you give the repository in `pom.xml`. These pages use
the workspace's slug:

```xml
<settings>
  <servers>
    <server>
      <id>acme</id>
      <username>ada</username>
      <password>${env.G1T_TOKEN}</password>
    </server>
  </servers>
</settings>
```

Maven reads `${env.G1T_TOKEN}` from the environment, so the token stays
out of the file.

For Gradle, keep them in `~/.gradle/gradle.properties`, named for the
repository (`acmeUsername` and `acmePassword` for a repository named
`acme`), or read them from the environment as the examples below do.

## Deploy with Maven

Name the repository in `pom.xml`, for releases and SNAPSHOTs alike, and say
which repository the source is in:

```xml
<project>
  <groupId>com.acme</groupId>
  <artifactId>http-client</artifactId>
  <version>0.3.1</version>

  <scm>
    <url>https://g1t.sh/acme/http-client</url>
  </scm>

  <distributionManagement>
    <repository>
      <id>acme</id>
      <url>https://g1t.sh/-/maven/acme/</url>
    </repository>
    <snapshotRepository>
      <id>acme</id>
      <url>https://g1t.sh/-/maven/acme/</url>
    </snapshotRepository>
  </distributionManagement>
</project>
```

```sh
mvn deploy
```

Maven uploads the artifact, its POM and their checksums, then the
artifact's `maven-metadata.xml`. The artifact is named by its coordinates,
`com.acme:http-client`, and its page on g1t.sh shows the description from
the POM of its highest release.

## Deploy with Gradle

With the `maven-publish` plugin, in `build.gradle.kts`:

```kotlin
plugins {
    `java-library`
    `maven-publish`
}

group = "com.acme"
version = "0.3.1"

publishing {
    publications {
        create<MavenPublication>("library") {
            from(components["java"])
            pom {
                scm { url = "https://g1t.sh/acme/http-client" }
            }
        }
    }
    repositories {
        maven {
            name = "acme"
            url = uri("https://g1t.sh/-/maven/acme/")
            credentials(PasswordCredentials::class)
        }
    }
}
```

```sh
./gradlew publish
```

`credentials(PasswordCredentials::class)` reads `acmeUsername` and
`acmePassword` from `gradle.properties` or from the environment as
`ORG_GRADLE_PROJECT_acmeUsername` and `ORG_GRADLE_PROJECT_acmePassword`.

Gradle uploads the jar, the POM, the sources and javadoc jars if you build
them, and its Gradle Module Metadata (`.module`), each with its `.md5`,
`.sha1`, `.sha256` and `.sha512`. The `.module` file is served beside the
POM, so a Gradle build that depends on the artifact reads its variants
(API and runtime dependencies, capabilities) from it, and Maven reads the
POM. Gradle's `HEAD` requests, which it makes to check files it has
cached (with `--refresh-dependencies`, or for a SNAPSHOT), are answered
with each file's size and type.

## Which repository an artifact belongs to

The first file deployed makes the artifact. When a repository of the
workspace is named like its artifactId (`http-client`), it is linked to
that repository and has its visibility and roles: deploying needs Write
on it. Otherwise, the POM's `<scm><url>` (or its `<url>`) naming a g1t.sh
repository of the workspace links a new artifact to that repository, if you
may write to it. An artifact linked to neither is the workspace's, private,
and needs the workspace's Write base permission. See
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package).

## Depend on an artifact

In `pom.xml`, name the repository, with the same `id` as the `<server>`
holding your credentials:

```xml
<repositories>
  <repository>
    <id>acme</id>
    <url>https://g1t.sh/-/maven/acme/</url>
  </repository>
</repositories>

<dependencies>
  <dependency>
    <groupId>com.acme</groupId>
    <artifactId>http-client</artifactId>
    <version>0.3.1</version>
  </dependency>
</dependencies>
```

In Gradle:

```kotlin
repositories {
    mavenCentral()
    maven {
        name = "acme"
        url = uri("https://g1t.sh/-/maven/acme/")
        credentials(PasswordCredentials::class)
    }
}

dependencies {
    implementation("com.acme:http-client:0.3.1")
}
```

To fetch one artifact without a project:

```sh
mvn dependency:get -Dartifact=com.acme:http-client:0.3.1 \
  -DremoteRepositories=acme::default::https://g1t.sh/-/maven/acme/
```

## Maven plugins

A plugin is deployed like any other artifact, with `<packaging>maven-plugin</packaging>`.
g1t lists the plugins of each group in the group's own
`maven-metadata.xml` (`com/acme/maven-metadata.xml` for the group
`com.acme`), with the prefix each is called by: the `goalPrefix` from the
descriptor `maven-plugin-plugin` puts in its jar, else the one Maven
works out from its artifactId (`hello-maven-plugin` is `hello`).

To call a plugin by its prefix, as `mvn hello:greet`, name its group in
`~/.m2/settings.xml` and the repository as a plugin repository:

```xml
<settings>
  <pluginGroups>
    <pluginGroup>com.acme</pluginGroup>
  </pluginGroups>
  <profiles>
    <profile>
      <id>acme</id>
      <pluginRepositories>
        <pluginRepository>
          <id>acme</id>
          <url>https://g1t.sh/-/maven/acme/</url>
        </pluginRepository>
      </pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>acme</activeProfile>
  </activeProfiles>
</settings>
```

The group's metadata lists only the plugins the credentials' owner may
see. A plugin's full coordinates (`mvn com.acme:hello-maven-plugin:1.0.0:greet`)
work without the plugin group.

## SNAPSHOTs

A version ending in `-SNAPSHOT` takes a new build each time it is
deployed. Maven and Gradle upload each build's files with a timestamp and
build number in their names (`http-client-0.4.0-20261006.120000-3.jar`),
and the version's `maven-metadata.xml` names the newest build of each file,
which is what a build depending on `0.4.0-SNAPSHOT` resolves. Earlier
builds stay, by their full names.

## Versions and files

- **A release's files are written once.** Deploying a file of a released
  version again with different content is refused with `409`; the same
  content again is accepted, so a deploy that stopped part way can be run
  again. Bump the version to change a release.
- **Checksums are worked out by g1t.** The `.md5`, `.sha1`, `.sha256` and
  `.sha512` beside every file are answered from the file itself. Checksums
  uploaded are checked against it, and a mismatch is refused with `400`.
- **`maven-metadata.xml` is made by g1t** from the versions there, so it
  always lists every version, with the highest as `latest` and the highest
  that is not a SNAPSHOT as `release`, and a group's lists its
  [plugins](#maven-plugins). The one a build uploads is accepted and not
  kept.
- **The deploy's last step publishes it.** Maven and Gradle upload the
  artifact's `maven-metadata.xml` after its files. Then each version (or
  SNAPSHOT build) whose POM arrived in the deploy is published: it is an
  audit entry and a `package.published` event, with every file in place.
  A POM whose `groupId`, `artifactId` or `version` is not the one in its
  path is refused with `400`.

Delete a version, or the artifact, on its page on g1t.sh, with Admin on
the linked repository (an owner, for the workspace's own artifacts).

## Private and public artifacts

An artifact linked to a repository has the repository's visibility; one of
the workspace's own is private until an owner makes it public on its page.

| The workspace's artifacts | Without credentials | With credentials |
| --- | --- | --- |
| All public | Maven and Gradle download them. | The same; credentials are sent to deploy. |
| Some private | Every request without credentials is answered `401`, which makes Maven and Gradle send theirs. | Each artifact the credentials' owner may see. |

A private artifact you cannot see looks exactly like one that does not
exist.

## In workflows

A workflow's `G1T_TOKEN`, [the job's own token](/guides/actions/#the-jobs-token), can resolve the workspace's artifacts,
and deploy them with `packages: write` in its [`permissions:`](/guides/actions/#the-jobs-token). With the `settings.xml`
above, give it to Maven as `G1T_TOKEN`:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    env:
      G1T_TOKEN: ${{ secrets.G1T_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: |
          mkdir -p ~/.m2
          printf '<settings><servers><server><id>acme</id><username>g1t</username><password>${env.G1T_TOKEN}</password></server></servers></settings>\n' > ~/.m2/settings.xml
      - run: mvn --batch-mode deploy
```

For Gradle, set `ORG_GRADLE_PROJECT_acmeUsername: g1t` and
`ORG_GRADLE_PROJECT_acmePassword: ${{ secrets.G1T_TOKEN }}` and run
`./gradlew publish`.

## Size

Each file is one request and may be at most 100 MB. Without the
[g1t plan](/guides/usage-and-billing/#the-g1t-plan), a workspace's private
packages may hold 500 MB and its public ones 10 GB, as for
[container images](/guides/containers/#storage-and-pull-limits). A file is
stored once, by its content.

## Errors

| Error | Means |
| --- | --- |
| `401` | No credentials, or a wrong or expired token. Check the `<server>` whose `id` matches the repository's, or Gradle's `acmeUsername` and `acmePassword`. |
| `403` | Signed in, but your role or your token's scopes do not allow it, or the workspace is out of free package storage. The response says which. |
| `404` | No such artifact, version or file, or a private one you cannot see. |
| `409` | That file of a release is already there with other content. Bump the version. |
| `400` | The upload was refused: a POM that does not match its path, or a checksum that does not match its file. The response says which. |
| `413` | The file is over 100 MB. |
