package main

import "fmt"

type Runner struct {
	name string
}

func (r *Runner) Start(input string) {
	fmt.Println(input)
}

func NewRunner(name string) *Runner {
	return &Runner{name: name}
}
