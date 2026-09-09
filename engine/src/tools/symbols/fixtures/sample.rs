pub struct Config {
    pub name: String,
}

pub enum State {
    Running,
    Stopped,
}

pub trait Runnable {
    fn run(&self);
}

pub struct Agent {
    config: Config,
}

impl Agent {
    pub fn new(config: Config) -> Self {
        Agent { config }
    }

    pub fn start(&mut self) {
        println!("starting {}", self.config.name);
    }
}
