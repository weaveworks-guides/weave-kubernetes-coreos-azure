var _ = require('underscore');

var fs = require('fs');
var cp = require('child_process');

var yaml = require('js-yaml');

var openssl = require('openssl-wrapper');

var clr = require('colors');
var inspect = require('util').inspect;

var util = require('./util.js');

var coreos_image_urns = {
  'stable': 'coreos:CoreOS:Stable:835.9.0',
  'beta': 'coreos:CoreOS:Beta:877.1.0',
  'alpha': 'coreos:CoreOS:Alpha:891.0.0' // untested
};

var conf = {};

var hosts = {
  collection: [],
};

var task_queue = [];

exports.run_task_queue = function (dummy) {
  var tasks = {
    todo: task_queue,
    done: [],
  };

  var pop_task = function() {
    console.log(clr.yellow('azure_wrapper/task:'), clr.grey(inspect(tasks)));
    var ret = {};
    ret.current = tasks.todo.shift();
    ret.remaining = tasks.todo.length;
    return ret;
  };

  (function iter (task) {
    if (task.current === undefined) {
      if (conf.destroying === undefined) {
        create_ssh_conf();
        save_state();
      }
      return;
    } else {
      if (task.current.length !== 0) {
        console.log(clr.yellow('azure_wrapper/exec:'), clr.blue(inspect(task.current)));
        cp.fork('node_modules/azure-cli/bin/azure', task.current)
          .on('exit', function (code, signal) {
            tasks.done.push({
              code: code,
              signal: signal,
              what: task.current.join(' '),
              remaining: task.remaining,
            });
            if (code !== 0 && conf.destroying === undefined) {
              console.log(clr.red('azure_wrapper/fail: Exiting due to an error.'));
              save_state();
              console.log(clr.cyan('azure_wrapper/info: You probably want to destroy and re-run.'));
              process.abort();
            } else {
              iter(pop_task());
            }
        });
      } else {
        iter(pop_task());
      }
    }
  })(pop_task());
};

var save_state = function () {
  var file_name = util.join_output_file_path(conf.name, 'deployment.yml');
  try {
    conf.hosts = hosts.collection;
    fs.writeFileSync(file_name, yaml.safeDump(conf));
    console.log(clr.yellow('azure_wrapper/info: Saved state into `%s`'), file_name);
  } catch (e) {
    console.log(clr.red(e));
  }
};

var load_state = function (file_name) {
  try {
    conf = yaml.safeLoad(fs.readFileSync(file_name, 'utf8'));
    console.log(clr.yellow('azure_wrapper/info: Loaded state from `%s`'), file_name);
    return conf;
  } catch (e) {
    console.log(clr.red(e));
  }
};

var create_ssh_key = function (prefix) {
  var opts = {
    x509: true,
    nodes: true,
    newkey: 'rsa:2048',
    subj: '/O=Weaveworks, Inc./L=London/C=GB/CN=weave.works',
    keyout: util.join_output_file_path(prefix, 'ssh.key'),
    out: util.join_output_file_path(prefix, 'ssh.pem'),
  };
  openssl.exec('req', opts, function (err, buffer) {
    if (err) console.log(clr.red(err));
    openssl.exec('rsa', { in: opts.keyout, out: opts.keyout }, function (err, buffer) {
      if (err) console.log(clr.red(err));
      fs.chmod(opts.keyout, '0600', function (err) {
        if (err) console.log(clr.red(err));
      });
    });
  });
  return {
    key: opts.keyout,
    pem: opts.out,
  }
}

var create_ssh_conf = function () {
  var file_name = util.join_output_file_path(conf.name, 'ssh_conf');
  var ssh_conf_head = [
    "Host *",
    "\tUser " + conf.default_admin_username,
    "\tCompression yes",
    "\tLogLevel FATAL",
    "\tStrictHostKeyChecking no",
    "\tUserKnownHostsFile /dev/null",
    "\tIdentitiesOnly yes",
    "\tIdentityFile " + conf.resources['ssh_key']['key'],
    "\n",
  ];

  fs.writeFileSync(file_name, ssh_conf_head.concat(_.map(hosts.collection, function (host) {
    return _.template("Host <%= name %>\n\tHostname <%= name %>-" +
      [util.rand_suffix, get_location_name(), "cloudapp.azure.com\n"].join('.'))(host);
  })).join('\n'));
  console.log(clr.yellow('azure_wrapper/info:'), clr.green('Saved SSH config, you can use it like so: `ssh -F ', file_name, '<hostname>`'));
  console.log(clr.yellow('azure_wrapper/info:'), clr.green('The hosts in this deployment are:\n'), _.map(hosts.collection, function (host) { return host.name; }));
};

var get_location_name = function () {
  if (process.env['AZ_LOCATION']) {
    return process.env['AZ_LOCATION'];
  } else {
    return 'westeurope';
  }
}
var get_vm_size = function () {
  if (process.env['AZ_VM_SIZE']) {
    return '--vm-size=' + process.env['AZ_VM_SIZE'];
  } else {
    return '--vm-size=Small';
  }
}

exports.queue_configure_arm_mode = function () {
  task_queue.push([
    'config', 'mode', 'arm'
  ]);
}

exports.queue_default_resource_group = function () {
  task_queue.push([
    'group', 'create',
    '--location=' + get_location_name(),
    conf.resources['group']
  ]);
}

exports.queue_default_network = function () {
  task_queue.push([
    'network', 'vnet', 'create',
    '--location=' + get_location_name(),
    '--address-prefixes=172.16.0.0/24',
    '--resource-group=' + conf.resources['group'],
    '--name=' + conf.resources['vnet']
  ]);
  task_queue.push([
    'network', 'vnet', 'subnet', 'create',
    '--address-prefix=172.16.0.0/24',
    '--resource-group=' + conf.resources['group'],
    '--vnet-name=' + conf.resources['vnet'],
    '--name=' + conf.resources['vnet_subnet']
  ]);
}

exports.queue_storage_if_needed = function() {
  if (!process.env['AZURE_STORAGE_ACCOUNT']) {
    conf.resources['storage_account'] = util.rand_suffix;
    task_queue.push([
      'storage', 'account', 'create',
      '--type=LRS',
      '--location=' + get_location_name(),
      '--resource-group=' + conf.resources['group'],
      conf.resources['storage_account'],
    ]);
    process.env['AZURE_STORAGE_ACCOUNT'] = conf.resources['storage_account'];
  } else {
    // Preserve it for resizing, so we don't create a new one by accedent,
    // when the environment variable is unset
    conf.resources['storage_account'] = process.env['AZURE_STORAGE_ACCOUNT'];
  }
};

exports.queue_machines = function (name_prefix, coreos_update_channel, cloud_config_creator) {
  var x = conf.nodes[name_prefix];
  var vm_create_base_args = [
    'vm', 'create',
    '--location=' + get_location_name(),
    get_vm_size(),
    '--vnet-name=' + conf.resources['vnet'],
    '--vnet-subnet-name=' + conf.resources['vnet_subnet'],
    '--ssh-publickey-file=' + conf.resources['ssh_key']['pem'],
    '--resource-group=' + conf.resources['group'],
    '--os-type=Linux',
    '--admin-username=' + conf['default_admin_username'],
    '--admin-password=' + conf['default_admin_password']
  ];

  var cloud_config = cloud_config_creator(x, conf);

  var next_host = function (n) {
    var host = { name: util.hostname(n, name_prefix) };
    if (cloud_config instanceof Array) {
      host.cloud_config_file = cloud_config[n];
    } else {
      host.cloud_config_file = cloud_config;
    }
    hosts.collection.push(host);
    return _.map([
        "--name=<%= name %>",
        "--public-ip-name=<%= name %>-" + util.rand_suffix,
        "--public-ip-domain-name=<%= name %>-" + util.rand_suffix,
        "--nic-name=<%= name %>-nic",
        "--custom-data=<%= cloud_config_file %>"
    ], function (arg) { return _.template(arg)(host); });
  };

  task_queue = task_queue.concat(_(x).times(function (n) {
    if (conf.resizing && n < conf.old_size) {
      return [];
    } else {
      return vm_create_base_args.concat(next_host(n), [
        '--image-urn=' + coreos_image_urns[coreos_update_channel]
      ]);
    }
  }));
};

exports.create_config = function (name, nodes) {
  conf = {
    name: name,
    nodes: nodes,
    weave_salt: util.rand_string(),
    default_admin_username: 'core',
    // require a password with at least one number, one lowercase, one uppercase and one symbol
    default_admin_password: util.rand_string().substring(31) + '#A',
    resources: {
      vnet: [name, 'internal-vnet', util.rand_suffix].join('-'),
      vnet_subnet: 'default',
      group: [name, util.rand_suffix].join('-'),
      ssh_key: create_ssh_key(name)
    }
  };

};

exports.destroy_cluster = function (state_file) {
  load_state(state_file);
  if (conf.hosts === undefined) {
    console.log(clr.red('azure_wrapper/fail: Nothing to delete.'));
    process.abort();
  }

  conf.destroying = true;
  task_queue = _.map(conf.hosts, function (host) {
    // TODO: --blob-delete equivalent for ARM
    return ['vm', 'delete', '--quiet', '--resource-group=' + conf.resources['group'], host.name];
  });

  task_queue.concat(_.map(conf.hosts, function (host) {
    return ['network', 'nic', 'delete', '--quiet', '--resource-group=' + conf.resources['group'],
      '--name=' + host.name + '-nic'];
  }));

  task_queue.push(['network', 'vnet', 'delete', '--quiet',
    '--resource-group=' + conf.resources['group'], conf.resources['vnet']]);
  task_queue.push(['storage', 'account', 'delete', '--quiet',
    '--resource-group=' + conf.resources['group'], conf.resources['storage_account']]);
  task_queue.push(['group', 'delete', '--quiet',
    '--name=' + conf.resources['group']]);
  exports.run_task_queue();
};

exports.load_state_for_resizing = function (state_file, node_type, new_nodes) {
  load_state(state_file);
  if (conf.hosts === undefined) {
    console.log(clr.red('azure_wrapper/fail: Nothing to look at.'));
    process.abort();
  }
  conf.resizing = true;
  conf.old_size = conf.nodes[node_type];
  conf.old_state_file = state_file;
  conf.nodes[node_type] += new_nodes;
  hosts.collection = conf.hosts;
  process.env['AZURE_STORAGE_ACCOUNT'] = conf.resources['storage_account'];
}
