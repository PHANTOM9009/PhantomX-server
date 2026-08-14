// Example script to launch and set up an EC2 instance
const { createInstance } = require('../src/ec2');
const { setupFileStructure } = require('../src/ssh');

(async () => {
  const instanceId = await createInstance();
  await setupFileStructure(instanceId);
  console.log('Setup complete for', instanceId);
})();
