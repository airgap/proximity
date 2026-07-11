// proximity CI/CD — Jenkins (this shop runs Jenkins, not GitHub Actions).
// Polls github.com/airgap/proximity (*/main). On a green build it tests, validates
// the deploy compose profiles, builds + pushes the app images to public GHCR, and
// redeploys the spatial.lyku.co droplet (pull + restart web/world-server).
//
// Host tokens in /etc/default/jenkins-doppler (agent mounts it):
//   DOPPLER_TOKEN_PARABUN_CI → GHCR_PUBLISH_TOKEN (ci/prd, GHCR push PAT)
//   DOPPLER_TOKEN_LYKUCO_CI  → API_IP/USER/SSH_KEY (ci/prd, droplet SSH)
pipeline {
    agent {
        docker {
            image 'lyku-ci-services:latest'
            alwaysPull false
            label 'linux'
            args '-e HOME=/tmp -e USER=jenkins -v /var/lib/jenkins/ci-cache/bun:/cache/parabun -v /var/run/docker.sock:/var/run/docker.sock -v /etc/default/jenkins-doppler:/etc/default/jenkins-doppler:ro --group-add 126'
        }
    }

    environment {
        CI = 'true'
        USER = 'jenkins'
    }

    options {
        skipDefaultCheckout(true)
        timestamps()
        ansiColor('xterm')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '15'))
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout([$class: 'GitSCM', branches: scm.branches,
                    extensions: [[$class: 'CloneOption', shallow: true, depth: 1]],
                    userRemoteConfigs: scm.userRemoteConfigs])
                script { env.SHORT_SHA = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim() }
            }
        }

        stage('Install') {
            steps { sh 'bun install --frozen-lockfile' }
        }

        stage('Test') {
            // Unit + integration. The parabun:* whisper test self-skips without
            // PROXIMITY_TEST_MODELS, so CI stays fast.
            steps { sh 'bun test' }
        }

        stage('Compose lint') {
            steps {
                dir('deploy') {
                    sh '''
                        set -e
                        if ! docker compose version >/dev/null 2>&1; then
                            echo "docker compose plugin unavailable on the agent — skipping compose lint"; exit 0
                        fi
                        base="-f docker-compose.yml -f docker-compose.app.yml"
                        docker compose -f docker-compose.yml -f docker-compose.local.yml config >/dev/null
                        for env in aws cfdo onprem; do
                            echo "checking profile: $env"
                            LIVEKIT_API_SECRET=x docker compose $base -f docker-compose.$env.yml config >/dev/null
                        done
                        docker compose $base -f docker-compose.gpu.yml config >/dev/null
                        echo "all compose profiles valid"
                    '''
                }
            }
        }

        // The job builds */main only, so every green build ships. Test/lint above
        // gate this — a failure stops the pipeline before any push or deploy.
        stage('Build & push images') {
            steps {
                sh '''
                    set -eu
                    set +x
                    PARABUN_CI_TOKEN=$(grep '^DOPPLER_TOKEN_PARABUN_CI=' /etc/default/jenkins-doppler | cut -d= -f2-)
                    [ -n "$PARABUN_CI_TOKEN" ] || { echo "DOPPLER_TOKEN_PARABUN_CI missing on host"; exit 1; }
                    TH=$(mktemp -d)
                    GHCR_TOKEN=$(HOME=$TH DOPPLER_TOKEN="$PARABUN_CI_TOKEN" doppler secrets get GHCR_PUBLISH_TOKEN --plain --project ci --config prd)
                    rm -rf "$TH"
                    echo "$GHCR_TOKEN" | docker login ghcr.io -u airgap --password-stdin
                    set -x
                    REG=ghcr.io/airgap
                    for app in web server; do
                        docker build -f apps/$app/Dockerfile \
                            -t "$REG/proximity-$app:latest" \
                            -t "$REG/proximity-$app:${SHORT_SHA}" .
                        docker push "$REG/proximity-$app:latest"
                        docker push "$REG/proximity-$app:${SHORT_SHA}"
                    done
                '''
            }
        }

        stage('Deploy droplet') {
            steps {
                sh '''
                    set -eu
                    set +x
                    export DOPPLER_TOKEN=$(grep '^DOPPLER_TOKEN_LYKUCO_CI=' /etc/default/jenkins-doppler | cut -d= -f2-)
                    [ -n "$DOPPLER_TOKEN" ] || { echo "DOPPLER_TOKEN_LYKUCO_CI missing on host"; exit 1; }
                    set -x
                    # ci-deploy.sh reads API_IP/USER/SSH_KEY from the env and pulls+restarts
                    # web/world-server on the droplet (images pinned to GHCR in its co.yml).
                    doppler run --project ci --config prd -- bash deploy/ci-deploy.sh
                '''
            }
        }
    }

    post {
        always {
            sh 'docker logout ghcr.io >/dev/null 2>&1 || true'
        }
    }
}
