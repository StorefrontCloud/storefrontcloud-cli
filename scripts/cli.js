#!/usr/bin/env node

const program = require('commander')
const inquirer = require('inquirer')
const shell = require('shelljs')
const fs = require('fs')
const chalk = require('chalk')
const path = require('path')
const jsonFile = require('jsonfile')
const os = require('os')
const Table = require('cli-table')
const child_process = require('child_process')

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, label, printf } = format;

const myFormat = printf(info => {
  let color = 'green'
  if (info.level === 'error') color = 'red'
  if (info.level === 'warn') color = 'yellow'
  return chalk[color].bold(`${info.timestamp} [${info.level}]:`) + ` ${info.message}`;
});

const logger = createLogger({
  format: combine(
    timestamp(),
    myFormat
  ),
  transports: [new transports.Console()]
});

const KUBECONFIG_PATH = path.resolve('.kube.config')
const CONFIG_PATH = path.resolve('.storefrontcloud.config')
const PODS_CACHE_PATH = path.resolve('.storefrontcloud.pods.cache')
const PHASE_RUNNING = 'Running'
let PODS_CACHE = []
let CONTEXT = { // defaults
  is_kubeconfig_a_file: true,
  is_kubectl_installed: false,
  kubectl_path: 'kubectl',
  kubeconfig_content: '',
  kubeconfig_file: path.join(os.homedir(), '.kube', 'config'),
  current_namespace: 'example-storefrontcloud-io',
  current_pod: ''
}
if (fs.existsSync(CONFIG_PATH)) {
  CONTEXT = jsonFile.readFileSync(CONFIG_PATH) 
  // TODO - load namespace and POD name from the ENV?
}
if (fs.existsSync(PODS_CACHE_PATH)) {
  PODS_CACHE = jsonFile.readFileSync(PODS_CACHE_PATH) 
  // TODO - load namespace and POD name from the ENV?
}


const kubeCtlCmd = (commandArray, cmdParams, CONTEXT) => {
  child_process.execFileSync(CONTEXT.kubectl_path, [...commandArray, CONTEXT.current_pod, '--kubeconfig', CONTEXT.kubeconfig_file, '-n', CONTEXT.current_namespace, ...cmdParams], {stdio: 'inherit'})
}

const kubeCtlCmdRaw = (commandArray, cmdParams, CONTEXT) => {
  cmdParams = cmdParams.map(r => {
    const pathArray = r.split(':')
    if (pathArray.length === 2) {
      r = [guessByRole(pathArray[0], PODS_CACHE, CONTEXT), pathArray[1]].join(':')
    }
    return r
  })
  child_process.execFileSync(CONTEXT.kubectl_path, [...commandArray, '--kubeconfig', CONTEXT.kubeconfig_file, '-n', CONTEXT.current_namespace, ...cmdParams], {stdio: 'inherit'})
}

const remoteExec = (remoteCmd, CONTEXT) => {
  try {
    return kubeCtlCmd(['exec'], ['-it', '--', ...remoteCmd], CONTEXT)
  } catch (err) {
    // console.error(err);
    process.exit(-1)
  } 
}

const outputPodsList = (items, CONTEXT, format = '') => {
  if (format == 'json') {
    console.log(JSON.stringify(items))
  } else {
    const table = new Table({
      head: [' ', 'POD name', 'Role', 'State', 'Start time'],
      colWidths: [3, 45, 10, 10, 25]
    });
  
    for (let pod of items) {
      table.push([pod.metadata.name === CONTEXT.current_pod ? '*' : '', pod.metadata.name, pod.role ? pod.role : '', pod.status.phase, pod.status.startTime ? pod.status.startTime : ''])
    }  
    console.log(table.toString())
  }
}
const guessByRole = (role, PODS_CACHE, CONTEXT) => {
  if (role === 'pod') return CONTEXT.current_pod
  const filteredPods = PODS_CACHE.filter(i => i.role === role).sort((podA, podB) => {
    if (podA.status.phase === podB.status.phase) return 0
    if (podA.status.phase === PHASE_RUNNING) return -1
    return 1
  })
  if (filteredPods.length > 0) return filteredPods[0].metadata.name; else return role
}

const guessApiPodName = (PODS_CACHE, CONTEXT) => {
  return guessByRole('api', PODS_CACHE, CONTEXT)
}

const guessFrontPodName = (PODS_CACHE, CONTEXT) => {
  return guessByRole('front', PODS_CACHE, CONTEXT)
}

const guessNginxPodName = (PODS_CACHE, CONTEXT) => {
  return guessByRole('nginx', PODS_CACHE, CONTEXT)
}

const guessRedisPodName = (PODS_CACHE, CONTEXT) => {
  return guessByRole('redis', PODS_CACHE, CONTEXT)
}

const guessESPodName = (PODS_CACHE, CONTEXT) => {
  return guessByRole('elastic', PODS_CACHE, CONTEXT)
}
const runInternalCommand = (alias, args = []) => {
  program._events[`command:${alias}`](args)
}

const assignContext = (map) => {
  return Object.assign({}, CONTEXT, map)
}

const processOutput = (output, format = 'human', humanReadableCallback = null) => {
  if (format == 'human') {
    if (humanReadableCallback) {
      humanReadableCallback(output)
    } else {
      console.log(humanReadableCallback)
    }
  } else {
    console.log(JSON.stringify(output))
  }
}

const setupCmdContext = (args, cmd, CONTEXT, PODS_CACHE) => {
  if(cmd.pod) {
    cmd.pod = guessByRole(cmd.pod, PODS_CACHE, CONTEXT)
  }
  if (args && args.length > 0) {
    const guess = guessByRole(args[0], PODS_CACHE, CONTEXT)
    if (guess !== args[0]) {
      cmd.pod = guess
    }
  } 
  return cmd  
}

const guessRole = (name) => {
  if (name.indexOf('vue-storefront-api-') >= 0) {
    return 'api'
  } else {
    if (name.indexOf('vue-storefront-') >= 0) {
      return 'front'
    }
    if (name.indexOf('redis-') >= 0) {
      return 'redis'
    }            
    if (name.indexOf('elasticsearch-') >= 0) {
      return 'elastic'
    }            
    if (name.indexOf('nginx-') >= 0) {
      return 'nginx'
    }            
  }
  return ''
}

const cachePodsList = (CONTEXT, PODS_CACHE, rollCurrentPod = false, format = '') => {
  const client = apiClient(CONTEXT)
  client.api.v1.namespaces(CONTEXT.current_namespace).pods.get().then((result) => {
      PODS_CACHE = result.body.items
      if (PODS_CACHE) {
        PODS_CACHE = PODS_CACHE.map(pod => {
          pod.role = guessRole(pod.metadata.name)
          return pod
        })

        if (rollCurrentPod) {
          const newCurrentPod = PODS_CACHE.find(p=> {
            return p.role === guessRole(CONTEXT.current_pod)
          })
          if (newCurrentPod) {
            CONTEXT.current_pod = newCurrentPod.metadata.name
            if (format !== 'json') console.log('Current POD has been switched to the ' + chalk.bold.green(CONTEXT.current_pod))
            jsonFile.writeFileSync(CONFIG_PATH, CONTEXT)
          }
        }       
      }
      jsonFile.writeFileSync(PODS_CACHE_PATH, PODS_CACHE)
      if (format !== 'json') console.log('PODs cache saved to ' + chalk.green.bold(PODS_CACHE_PATH))
      outputPodsList(PODS_CACHE, CONTEXT, format)
  })      
}

const updateConfig = (answers, CONTEXT, rollCurrentPod = false) => {
  try {
    CONTEXT = Object.assign({}, CONTEXT, answers)
    if (!CONTEXT.is_kubeconfig_a_file) {
      CONTEXT.kubeconfig_file = KUBECONFIG_PATH
      CONTEXT.is_kubeconfig_a_file = true
      fs.writeFileSync(KUBECONFIG_PATH, CONTEXT.kubeconfig_content)
      console.log('Kubeconfig file has been saved to ' + chalk.green.bold(KUBECONFIG_PATH))
    }

    if (!CONTEXT.is_kubectl_installed) {
      const isWin = process.platform.indexOf("win") == 0

      if (isWin) {
        console.log('I can not install ' + chalk.red.bold('kubectl') +' on Windows platform. Please follow the instructions: https://kubernetes.io/docs/tasks/tools/install-kubectl/#install-kubectl-binary-using-curl before You continue.')
      } else {
        const platform = process.platform
        const kubectlPath = path.join(process.cwd(), 'kubectl')
        if (fs.existsSync(kubectlPath)) shell.rm(kubectlPath)
        console.log('I will download the ' + chalk.bold.green('kubectl') +' binary file to current directory (' + process.cwd() + ').')
        shell.exec('curl -LO https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/' + platform + '/amd64/kubectl')
        shell.exec(`chmod +x ${kubectlPath}`)
        if (shell.exec(`${kubectlPath} version`).code === 0) {
          console.log(chalk.bold.green('kubectl') + ' has been ' + chalk.green('successfully installed in: ') + chalk.green(kubectlPath))
        }
        CONTEXT.kubectl_path = kubectlPath
        CONTEXT.is_kubectl_installed = true
      }
      
    }
    jsonFile.writeFileSync(CONFIG_PATH, CONTEXT)
    console.log(chalk.green.bold('\n\nConfig file has been updated\n\n'))
    console.log('Your default Namespace is ' + chalk.cyan.bold(CONTEXT.current_namespace) + '. All subsequent commands will be executed in this context')
    console.log('You may want to use Your test environemnt by switching Namespace to ' + chalk.cyan.bold('{somename}-test-storefrontcloud-io') + '.')

    console.log('To switch the current namespace You can use ' + chalk.bold('--ns <nameSpace>') + ' parameter or run ' + chalk.green.bold('cli.js switch') + ' command')

    cachePodsList(CONTEXT, PODS_CACHE, rollCurrentPod)
  } catch (e) {
    logger.error(e)
    process.exit(-1)
  }
}

const apiClient = (storefrontConfig) => {
  const Client = require('kubernetes-client').Client
  const config = require('kubernetes-client').config

  let kubeConfig = config.fromKubeconfig(storefrontConfig.kubeconfig_file)
  const client = new Client({ config: kubeConfig, version: '1.9' });
  return client
}
/**
 * LIST AVAILABLE PODS
 */
program
  .command('pods')
  .option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
  .option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
  .option('--format <format>', 'output format, by default human readable - other option is "json"', 'human')
  .action((cmd) => {
  try {
      cachePodsList(Object.assign({}, CONTEXT, { current_namespace: cmd.ns, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE, false, cmd.format)
    } catch (e) {
      logger.error(e)
      process.exit(-1)
    }
  })

/**
 * EXECUTE THE COMMAND ON REMOTE POD
 */
program
.command('execApi [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  try {
    const client = apiClient(CONTEXT)

    // Pod with single container
    client.api.v1.namespaces(cmd.ns).pods(cmd.pod).exec.post({
      qs: {
        command: remoteCmd,
        stdout: true,
        stderr: true,
        stdin: true
      }
    }).then((res) => {
    })
  } catch (err) {
    console.error('Error: ', err);
  } 
})

/**
 * EXECUTE THE COMMAND ON REMOTE POD using KUBECTL
 */
program
.command('exec [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  remoteExec(remoteCmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
})

/**
 * EXECUTE THE DEPLOY PROCEDURE
 */
program
.command('deploy [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((args, cmd) => {
  setupCmdContext(args, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmd(['delete', 'pod'], [], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  console.log('The POD has been successfully deleted. Please use ' + chalk.green.bold('node scripts/cli.js pod') + ' to select new default POD')
  updateConfig({}, CONTEXT, true)
}) 

/**
 * EXECUTE THE PM2 LOGS PREVIEW
 */
program
.command('logs [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  remoteExec(['yarn', 'pm2', 'logs', ...remoteCmd], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 


/**
 * EXECUTE THE KUBECTL COPY
 */
program
.command('cp [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmdRaw(['cp'], remoteCmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

/**
 * EXECUTE THE KUBECTL logs
 */
program
.command('podLogs [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmdRaw(['logs'], [cmd.pod], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

/**
 * EXECUTE THE KUBECTL logs
 */
program
.command('buildLogs [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmdRaw(['logs', '-c', 'build'], [cmd.pod], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

/**
 * EXECUTE THE KUBECTL logs
 */
program
.command('installLogs [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmdRaw(['logs', '-c', 'install'], [cmd.pod], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

/**
 * EXECUTE THE KUBECTL logs
 */
program
.command('describe [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  kubeCtlCmdRaw(['describe'], [cmd.pod], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 


/**
 * EXECUTE THE ElasticDump
 */
program
.command('dump [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', guessApiPodName(PODS_CACHE, CONTEXT))
.option('--output <outputFile>', 'outputFile name', 'catalog.json')
.action((remoteCmd, cmd) => {
  console.log('Preparing ElasticSearch dump on ' + chalk.bold.green(cmd.pod))
  shell.exec(`rm ${cmd.output}`)
  remoteExec(['rm', '/var/www/var/catalog.json'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  remoteExec(['yarn', 'dump'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  kubeCtlCmdRaw(['cp'], ['pod:/var/www/var/catalog.json', cmd.output], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  console.log('\n\nElasticSearch dump has been stored in local file: ' + chalk.green.bold(cmd.output))
}) 


/**
 * EXECUTE THE ElasticRestore
 */
program
.command('restore [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', guessApiPodName(PODS_CACHE, CONTEXT))
.option('--input <inputFile>', 'inputFile name', 'catalog.json')
.action((remoteCmd, cmd) => {
  console.log('Restoring ElasticSearch dump on ' + chalk.bold.green(cmd.pod))
  remoteExec(['rm', '/var/www/var/catalog.json'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  kubeCtlCmdRaw(['cp'], [cmd.input, 'pod:/var/www/var/catalog.json'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  remoteExec(['yarn', 'restore2main'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  remoteExec(['yarn', 'db', 'rebuild'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  console.log('\n\nElasticSearch dump has been restored from local file: ' + chalk.green.bold(cmd.input))
}) 


/**
 * EXECUTE THE Magento2 products import
 */
program
.command('import [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', guessApiPodName(PODS_CACHE, CONTEXT))
.action((remoteCmd, cmd) => {  
  console.log('Preparing Magento2 products import on ' + chalk.bold.green(cmd.pod))
  console.log('Please make sure that You configured the M2 API credentials in the vue-storefront-api repository: ' + chalk.yellow.bold())
  remoteExec(['yarn', 'mage2vs', 'import'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  console.log('\n\Magento2 products import has been successfully executed')
}) 


/**
 * Clear the SSR OUTPUT cache
 */
program
.command('clearCache [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', guessFrontPodName(PODS_CACHE, CONTEXT))
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  remoteExec(['npm', 'run', 'cache', 'clear'], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
  console.log('\n\SSR output cache has been cleared')
}) 




/**
 * EXECUTE THE YARN COMMAND ON REMOTE POD using KUBECTL
 */
program
.command('yarn [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  remoteExec(['yarn', ...remoteCmd], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

/**
 * EXECUTE THE PM2 COMMAND ON REMOTE POD using KUBECTL
 */
program
.command('pm2 [args...]')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', CONTEXT.current_namespace)
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'pod of storefrontcloud.io', CONTEXT.current_pod)
.action((remoteCmd, cmd) => {
  setupCmdContext(remoteCmd, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)
  remoteExec(['yarn', 'pm2', ...remoteCmd], assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }))
}) 

 /**
 * SWITCH THE CURRENT NAMESPACE
 */
program
.command('namespace')
.option('--ns <nameSpace>', 'nameSpace of storefrontcloud.io', null)
.action((cmd) => {
  if (cmd.ns) {
    updateConfig({ current_namespace: cmd.ns }, CONTEXT)
  } else {
    const questions = [
      {
        type: 'input',
        name: 'current_namespace',
        message: 'Please enter Your default namespace name',
        default: CONTEXT.current_namespace,
        validate: function (value) {
          if (value.indexOf('storefrontcloud-io') > 0) {
            return true
          } else {
            return 'The provided namespace name should be in format: instancename-storefrontcloud-io'
          }
        }
      }
    ]
    inquirer.prompt(questions).then(answers => updateConfig(answers, CONTEXT))
  }
}) 

 /**
 * SWITCH THE CURRENT POD
 */
program
.command('pod')
.option('--kubeConfig <kubeConfig>', 'kubeCofnig path', CONTEXT.kubeconfig_file)
.option('--pod <pod>', 'POD of storefrontcloud.io', CONTEXT.current_pod)
.action((cmd) => {
  setupCmdContext(null, cmd, assignContext({ current_namespace: cmd.ns, current_pod: cmd.pod, kubeconfig_file: cmd.kubeConfig }), PODS_CACHE)

  if (cmd.pod && cmd.pod !== CONTEXT.current_pod) {
    updateConfig({ current_pod: cmd.pod }, CONTEXT)
  } else {
    try {
      const client = apiClient(CONTEXT)
      let availablePods = []
      client.api.v1.namespaces(cmd.ns).pods.get().then((result) => {
          availablePods = result.body.items.map(pod => pod.metadata.name)
          const questions = [
            {
              type: 'list',
              name: 'current_pod',
              message: 'Select Your default POD name',
              default: CONTEXT.current_pod,
              choices: availablePods,
              validate: function (value) {
                if (value.indexOf('storefrontcloud-io') > 0) {
                  return true
                } else {
                  return 'The provided namespace name should be in format: instancename-storefrontcloud-io'
                }
              }
            }
          ]
          inquirer.prompt(questions).then(answers => updateConfig(answers, CONTEXT))
        })
      } catch (e) {
        console.error(e)
        process.exit(-1)
      }
    }
  }) 

/**
 * INIT CONFIGURATION FILE
 */
program
  .command('setup')
  .action((cmd) => {
    console.log('\n\nWelcome to ' + chalk.black.bgCyan.bold('Storefront Cloud') + ' setup\n\n')
    const questions = [
      {
        type: 'confirm',
        name: 'is_kubeconfig_a_file',
        message: 'Would you like to use Your existing kubernetes config file?',
        default: CONTEXT.is_kubeconfig_a_file
      },
      {
        type: 'editor',
        name: 'kubeconfig_content',
        message: 'Please paste the kubeconfig file provided by StorefrontCloud.io team:',
        default: CONTEXT.kubeconfig_content,
        when: function (answers) {
          return answers.is_kubeconfig_a_file === false
        },
        validate: function (value) {
          console.log(value)
          if (value.indexOf('apiVersion' )!== 0) {
            return 'The config file must start with "apiVersion: 1.0" token'
          } 
          return true
        }
      },
      {
        type: 'input',
        name: 'kubeconfig_file',
        message: 'Please provide the file path to kubeconfig file You would like to use',
        default: CONTEXT.kubeconfig_file,
        when: function (answers) {
          return answers.is_kubeconfig_a_file === true
        },
        validate: function (value) {
          if (fs.existsSync(path.resolve(value))) {
            return true
          } else {
            return 'The provided file path doesn not exists'
          }
        }
      },
      {
        type: 'confirm',
        name: 'is_kubectl_installed',
        message: 'Do You have kubectl cmdline tool installed?',
        default: CONTEXT.is_kubectl_installed
      },      
      {
        type: 'input',
        name: 'kubectl_path',
        message: 'Please enter the path to kubectl',
        default: CONTEXT.kubectl_path,
        when: function(answers) {
          return answers.is_kubectl_installed
        },
        validate: function (value) {
          if (shell.exec(value, { silent: true }).code === 0) {
            return true
          } else {
            return 'The provided kubectl file does not exists or or it is not executable file'
          }
        }
      },      
      {
        type: 'input',
        name: 'current_namespace',
        message: 'Please enter Your default namespace name',
        default: CONTEXT.current_namespace,
        validate: function (value) {
          if (value.indexOf('storefrontcloud-io') > 0) {
            return true
          } else {
            return 'The provided namespace name should be in format: instancename-storefrontcloud-io'
          }
        }
      }
    ]
    inquirer.prompt(questions).then(answers => updateConfig(answers, CONTEXT))
  })

program
  .on('command:*', () => {
    console.error('Invalid command: %s\nSee --help for a list of available commands.', program.args.join(' '));
    process.exit(1);
  });

program
  .parse(process.argv)

process.on('unhandledRejection', (reason, p) => {
  console.log("Unhandled Rejection at: Promise ", p, " reason: ", reason)
})

process.on('uncaughtException', function(exception) {
  console.log(exception)
})

