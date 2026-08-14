import { spawn } from 'child_process';

const command = `echo "=== RAM ===" && free -h && echo "" && echo "=== CPU ===" && grep -m1 "model name" /proc/cpuinfo && echo "Cores: $(nproc)"`;

const bash = spawn('bash', ['-c', command]);

bash.stdout.on('data', (data:any) => {
    console.log(data.toString());
});

bash.stderr.on('data', (data:any) => {
    console.error('stderr:', data.toString());
});

bash.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
        console.error('bash not found on this system. WSL or Git Bash may not be installed or not in PATH.');
    } else {
        console.error('Failed to spawn bash:', err.message);
    }
});

bash.on('close', (code:any) => {
    console.log(`bash exited with code ${code}`);
});
