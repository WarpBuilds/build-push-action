import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {exec} from 'child_process';
import {promisify} from 'util';
import {v4 as uuidv4} from 'uuid';
import * as core from '@actions/core';

const execAsync = promisify(exec);

interface BuilderConfig {
  profileName: string;
  apiKey?: string;
  timeout?: number;
}

interface BuilderInstance {
  id: string;
  arch: string;
  metadata: {
    host: string;
    ca: string;
    client_cert: string;
    client_key: string;
  };
  status: string;
}

interface AssignBuilderResponse {
  builder_instances: BuilderInstance[];
}

interface BuilderDetailsResponse extends BuilderInstance {}

export class WarpBuildRemoteBuilders {
  private readonly profileName: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly isWarpBuildRunner: boolean;
  private readonly scriptStartTime: number;
  private readonly apiDomain: string;
  private readonly builderName: string;
  private builderInstances: BuilderInstance[] = [];
  private certDirs: string[] = [];
  private assignmentPromise: Promise<void> | null = null;
  private initialized: boolean = false;

  constructor(config: BuilderConfig) {
    this.profileName = config.profileName;
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 200000; // Default timeout 200 seconds
    this.scriptStartTime = Date.now();
    this.apiDomain = process.env.WARPBUILD_API_DOMAIN || 'https://api.warpbuild.com';
    this.isWarpBuildRunner = Boolean(process.env.WARPBUILD_RUNNER_VERIFICATION_TOKEN);
    this.builderName = `builder-${uuidv4()}`;

    core.debug(`API domain: ${this.apiDomain}`);
    core.debug(`Is WarpBuild runner: ${this.isWarpBuildRunner}`);
    core.debug(`Builder name: ${this.builderName}`);

    this.validateInputs();
  }

  /**
   * Print Docker and Buildx information
   */
  public async printDockerInfo(): Promise<void> {
    await core.group(`Docker info`, async () => {
      try {
        const dockerVersion = await execAsync('docker --version');
        core.info(dockerVersion.stdout);

        const dockerInfo = await execAsync('docker info');
        core.info(dockerInfo.stdout);
      } catch (e) {
        core.info(`Error getting Docker info: ${e.message}`);
      }
    });

    await core.group(`Buildx version`, async () => {
      try {
        const buildxVersion = await execAsync('docker buildx version');
        core.info(buildxVersion.stdout);
      } catch (e) {
        core.info(`Error getting Buildx info: ${e.message}`);
      }
    });
  }

  /**
   * Check if required tools are available
   */
  public async checkRequiredTools(): Promise<void> {
    await core.group(`Checking required tools`, async () => {
      try {
        await execAsync('which jq');
        core.info('✓ jq is installed');
      } catch (error) {
        throw new Error('jq is not installed. Please install jq to use this action.');
      }

      try {
        await execAsync('which curl');
        core.info('✓ curl is installed');
      } catch (error) {
        throw new Error('curl is not installed. Please install curl to use this action.');
      }

      try {
        await execAsync('docker --version');
        core.info('✓ Docker is installed');
      } catch (error) {
        throw new Error('Docker is not installed. Please install Docker to use this action.');
      }

      try {
        await execAsync('docker buildx version');
        core.info('✓ Docker Buildx is installed');
      } catch (error) {
        core.warning('Docker Buildx not available. Will attempt to use Docker directly.');
      }
    });
  }

  /**
   * Start the builder assignment process
   * This method can be called separately and other tasks can run in parallel
   */
  public assignBuilder(): Promise<void> {
    // Store the promise so that setupBuilders() can wait for it if needed
    this.assignmentPromise = this._assignBuilder();
    return this.assignmentPromise;
  }

  /**
   * Internal implementation of the builder assignment process
   */
  private async _assignBuilder(): Promise<void> {
    const assignBuilderEndpoint = `${this.apiDomain}/api/v1/builders/assign`;
    let retryCount = 0;
    const staticWait = 10000; // 10 seconds

    await core.group(`Assigning WarpBuild builders for profile ${this.profileName}`, async () => {
      while (this.checkGlobalTimeoutNotExceeded()) {
        retryCount++;

        try {
          core.info(`Making API request to assign builder (attempt ${retryCount})...`);

          const authHeader = this.isWarpBuildRunner ? `Bearer ${process.env.WARPBUILD_RUNNER_VERIFICATION_TOKEN}` : `Bearer ${this.apiKey}`;

          const response = await fetch(assignBuilderEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authHeader
            },
            body: JSON.stringify({profile_name: this.profileName})
          });

          if (!response.ok) {
            const statusCode = response.status;

            // Determine if we should retry based on status code
            if (statusCode >= 500 || statusCode === 409 || statusCode === 429) {
              core.warning(`Assign builder failed: HTTP Status ${statusCode}`);
              core.info(`Waiting ${staticWait / 1000} seconds before next attempt...`);
              await new Promise(resolve => setTimeout(resolve, staticWait));
              continue;
            }

            // Not a retriable error
            const errorData = await response.json().catch(() => ({message: 'Unknown error'}));
            throw new Error(`API Error: HTTP Status ${statusCode} - ${JSON.stringify(errorData) || errorData.message || 'Unknown error'}`);
          }

          const data = (await response.json()) as AssignBuilderResponse;

          if (!data.builder_instances || data.builder_instances.length === 0) {
            throw new Error('No builder instances assigned');
          }

          core.info(`✓ Successfully assigned ${data.builder_instances.length} builder(s) after ${retryCount} attempts`);
          this.builderInstances = data.builder_instances;
          return;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('API Error:')) {
            throw error; // Re-throw non-retriable errors
          }

          core.warning(`Request error: ${error}`);
          core.info(`Waiting ${staticWait / 1000} seconds before next attempt...`);
          await new Promise(resolve => setTimeout(resolve, staticWait));
        }
      }

      throw new Error('Exceeded global timeout waiting for builder assignment');
    });
  }

  /**
   * Set up all builders
   * This can be called separately after assignBuilder has started
   */
  public async setupBuilders(): Promise<void> {
    // Wait for any ongoing assignment to complete first
    if (this.assignmentPromise) {
      await this.assignmentPromise;
    }

    if (!this.isAssigned()) {
      throw new Error('No builder instances assigned. Call assignBuilder() first.');
    }

    // Setup nodes sequentially to avoid race conditions
    for (let i = 0; i < this.builderInstances.length; i++) {
      await this.setupBuildxNode(i, this.builderInstances[i].id);
    }

    // Mark as initialized after setup is complete
    this.initialized = true;
  }

  /**
   * Check if builders have been assigned
   */
  public isAssigned(): boolean {
    return this.builderInstances.length > 0;
  }

  /**
   * Get the assigned builder count
   */
  public getBuilderCount(): number {
    return this.builderInstances.length;
  }

  /**
   * Get the assigned builder IDs
   */
  public getBuilderIds(): string[] {
    return this.builderInstances.map(instance => instance.id);
  }

  /**
   * Get the builder name
   */
  public getBuilderName(): string {
    return this.builderName;
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    // Remove builders
    if (this.builderName) {
      await core.group(`Removing builder`, async () => {
        try {
          const result = await execAsync(`docker buildx rm ${this.builderName}`);
          if (result.stderr) {
            core.warning(result.stderr);
          } else {
            core.info(`Builder ${this.builderName} removed`);
          }
        } catch (error) {
          core.warning(`Error removing builder: ${error.message}`);
        }
      });
    }

    // Clean up certificate directories
    for (const certDir of this.certDirs) {
      if (fs.existsSync(certDir)) {
        await core.group(`Cleaning up certificates in ${certDir}`, async () => {
          fs.rmSync(certDir, {recursive: true});
        });
      }
    }
  }

  /**
   * Check if global timeout has not been exceeded
   */
  private checkGlobalTimeoutNotExceeded(): boolean {
    const currentTime = Date.now();
    const totalElapsed = currentTime - this.scriptStartTime;

    if (totalElapsed > this.timeout) {
      core.warning(`Global script timeout of ${this.timeout}ms exceeded after ${totalElapsed}ms`);
      return false;
    }

    return true;
  }

  /**
   * Validate required inputs
   */
  private validateInputs(): void {
    if (!this.profileName) {
      throw new Error('Profile name is required');
    }

    if (!this.isWarpBuildRunner && !this.apiKey) {
      throw new Error('API key is required for non-WarpBuild runners');
    }
  }

  /**
   * Wait for builder details to be ready
   */
  private async waitForBuilderDetails(builderId: string): Promise<BuilderDetailsResponse> {
    const builderDetailsEndpoint = `${this.apiDomain}/api/v1/builders/${builderId}/details`;
    const authHeader = this.isWarpBuildRunner ? `Bearer ${process.env.WARPBUILD_RUNNER_VERIFICATION_TOKEN}` : `Bearer ${this.apiKey}`;

    while (this.checkGlobalTimeoutNotExceeded()) {
      try {
        const response = await fetch(builderDetailsEndpoint, {
          headers: {Authorization: authHeader}
        });

        if (!response.ok) {
          throw new Error(`Failed to get builder details: ${response.status}`);
        }

        const details = (await response.json()) as BuilderDetailsResponse;

        if (details.status === 'ready') {
          if (!details.metadata.host) {
            throw new Error(`Builder ${builderId} is ready but host information is missing`);
          }

          core.debug(`Builder ${builderId} is ready`);
          return details;
        } else if (details.status === 'failed') {
          throw new Error(`Builder ${builderId} failed to initialize`);
        }

        core.debug(`Builder ${builderId} status: ${details.status}. Waiting...`);
      } catch (error) {
        core.warning(`Error getting builder details: ${error}`);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Builder ${builderId} not ready after timeout`);
  }

  /**
   * Check if Docker port is available using curl
   */
  private async checkDockerEndpoint(host: string, certDir: string): Promise<boolean> {
    try {
      const tcpPrefix = 'tcp://';
      const serverInfo = host.startsWith(tcpPrefix) ? host.substring(tcpPrefix.length) : host;
      const [serverIp, serverPortStr] = serverInfo.split(':');
      const serverPort = serverPortStr ? parseInt(serverPortStr, 10) : 2376; // Default Docker TLS port

      core.debug(`Testing connection to Docker API at ${serverIp}:${serverPort}`);

      // Use curl directly to test the connection
      const curlCommand = `curl --connect-timeout 5 --max-time 10 --cacert "${certDir}/ca.pem" --cert "${certDir}/cert.pem" --key "${certDir}/key.pem" -s "https://${serverIp}:${serverPort}/version"`;

      const result = await execAsync(curlCommand);
      core.debug(result.stdout);
      return true;
    } catch (error) {
      core.debug(`Docker endpoint check error: ${error.message}`);
      return false;
    }
  }

  /**
   * Wait for Docker endpoint to be available
   */
  private async waitForDockerEndpoint(host: string, certDir: string): Promise<void> {
    const tcpPrefix = 'tcp://';
    const serverInfo = host.startsWith(tcpPrefix) ? host.substring(tcpPrefix.length) : host;
    const [serverIp, serverPortStr] = serverInfo.split(':');
    const serverPort = serverPortStr ? parseInt(serverPortStr, 10) : 2376;

    core.info(`Waiting for Docker endpoint at ${serverIp}:${serverPort}...`);

    while (this.checkGlobalTimeoutNotExceeded()) {
      if (await this.checkDockerEndpoint(host, certDir)) {
        core.info(`Docker endpoint at ${serverIp}:${serverPort} is available`);
        return;
      }

      core.debug(`Docker endpoint not available yet. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error('Docker endpoint not available after timeout');
  }

  /**
   * Create certificates for a builder node
   */
  private setupCertificates(builderId: string, ca: string, cert: string, key: string): string {
    // Create cert directory
    const homeDir = os.homedir();
    const certDir = path.join(homeDir, '.warpbuild', 'buildkit', this.builderName, builderId);
    fs.mkdirSync(certDir, {recursive: true});
    this.certDirs.push(certDir);

    // Write certificates
    fs.writeFileSync(path.join(certDir, 'ca.pem'), ca);
    fs.writeFileSync(path.join(certDir, 'cert.pem'), cert);
    fs.writeFileSync(path.join(certDir, 'key.pem'), key);

    // Verify certificate files were created properly
    const files = ['ca.pem', 'cert.pem', 'key.pem'];
    for (const file of files) {
      const filePath = path.join(certDir, file);
      const fileStats = fs.statSync(filePath);
      if (fileStats.size === 0) {
        throw new Error(`Failed to write certificate file ${file} for builder ${builderId}`);
      }
    }

    return certDir;
  }

  /**
   * Set up a buildx node using direct docker commands
   */
  private async setupBuildxNode(index: number, builderId: string): Promise<void> {
    await core.group(`Setting up builder node ${index} (ID: ${builderId})`, async () => {
      // Wait for builder details
      core.info(`Waiting for builder ${builderId} to be ready...`);
      const details = await this.waitForBuilderDetails(builderId);
      core.info(`Builder ${builderId} is ready`);

      // Extract information
      const builderHost = details.metadata.host;
      const builderCa = details.metadata.ca;
      const builderClientCert = details.metadata.client_cert;
      const builderClientKey = details.metadata.client_key;
      let builderPlatforms = details.arch;

      // Format the platform with "linux/" prefix if needed
      if (builderPlatforms && !builderPlatforms.includes('linux/')) {
        builderPlatforms = builderPlatforms
          .split(',')
          .map(platform => `linux/${platform}`)
          .join(',');
      }

      // Setup certificates
      core.info(`Setting up certificates for builder ${builderId}`);
      const certDir = this.setupCertificates(builderId, builderCa, builderClientCert, builderClientKey);

      // Wait for Docker endpoint to be available
      await this.waitForDockerEndpoint(builderHost, certDir);

      // Set up Docker buildx using direct commands
      const isFirstNode = index === 0;

      try {
        if (isFirstNode) {
          // First node - create a new builder
          core.info(`Creating buildx builder with name ${this.builderName}`);
          const buildxCreateCmd = `docker buildx create --name "${this.builderName}" --node "${builderId}" --driver remote --driver-opt "cacert=${certDir}/ca.pem" --driver-opt "cert=${certDir}/cert.pem" --driver-opt "key=${certDir}/key.pem" --platform "${builderPlatforms}" --use tcp://${builderHost}`;

          const createResult = await execAsync(buildxCreateCmd);
          core.debug(createResult.stdout);
          if (createResult.stderr) {
            core.warning(createResult.stderr);
          }

          core.info(`Builder ${this.builderName} created successfully`);
        } else {
          // Append this node to the existing builder
          core.info(`Appending node ${builderId} to builder ${this.builderName}`);
          const buildxAppendCmd = `docker buildx create --name "${this.builderName}" --append --node "${builderId}" --driver remote --driver-opt "cacert=${certDir}/ca.pem" --driver-opt "cert=${certDir}/cert.pem" --driver-opt "key=${certDir}/key.pem" --platform "${builderPlatforms}" --use tcp://${builderHost}`;

          const appendResult = await execAsync(buildxAppendCmd);
          core.debug(appendResult.stdout);
          if (appendResult.stderr) {
            core.warning(appendResult.stderr);
          }

          core.info(`Node ${builderId} appended to builder ${this.builderName}`);
        }
      } catch (error) {
        throw new Error(`Failed to setup buildx node: ${error.message}`);
      }
    });
  }
}
