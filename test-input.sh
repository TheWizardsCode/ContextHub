#!/bin/bash
# Test script to simulate OpenCode agent requesting input

echo "Starting OpenCode agent simulation..."
echo ""
echo "Processing your request..."
sleep 1

echo "[INPUT_REQUEST] What is your name?"
read -r name
echo "> $name"
echo "Hello, $name!"
echo ""

sleep 1

echo "I need to ask you something..."
echo "Do you want to continue? (y/n)"
read -r answer
echo "> $answer"

if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
    echo "Great! Let's proceed."
    echo ""
    sleep 1
    
    echo "[INPUT_REQUIRED] Please enter your favorite color:"
    read -r color
    echo "> $color"
    echo "Nice choice! $color is a great color."
else
    echo "Alright, stopping here."
fi

echo ""
echo "Task completed successfully!"